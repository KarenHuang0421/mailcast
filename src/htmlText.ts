// HTML → plain text that keeps headings, paragraphs, list items and links.
// Links are replaced by short markers like [L3]; the URLs are returned separately
// so Claude can reference them without the URLs ever going into the spoken script.
import { JSDOM, VirtualConsole } from "jsdom";

export interface ExtractedLink {
  ref: string; // "L3"
  url: string;
  text: string;
}

export interface ExtractedText {
  text: string;
  links: ExtractedLink[];
}

const TRACKING_PARAMS =
  /^(utm_\w+|mc_cid|mc_eid|_hsenc|_hsmi|hsCtaTracking|mkt_tok|vero_id|vero_conv|ck_subscriber_id|oly_enc_id|oly_anon_id|rb_clickid|s_cid|fbclid|gclid|dclid|msclkid|yclid|igshid|ref_src|trk|trkCampaign|sc_campaign|sc_channel|sc_content|sc_medium|sc_outcome|sc_geo|sc_country|__s|_bhlid|lctg|ref)$/i;

/** Remove common tracking query parameters. Returns null for non-http(s) links. */
export function cleanUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  }
  u.hash = "";
  return u.toString();
}

// Lines that are boilerplate in newsletters (best effort).
const BOILERPLATE_LINE =
  /(unsubscribe|退訂|取消訂閱|manage (your )?(preferences|subscription)|update (your )?preferences|email preferences|view (this email |it )?in (your )?browser|view online|forward(ed)? (this|to a friend)|you('re| are) receiving this|you received this|sent to .+@|no longer wish|privacy policy|©|all rights reserved)/i;
const SPONSOR_HEADING = /^(sponsor(ed)?( by)?|presented by|brought to you by|together with|partner(ed)? (content|with)|advertisement|廣告|贊助)\b/i;
const UNSUB_LINK_TEXT = /(unsubscribe|退訂|取消訂閱|preferences|view in browser|view online)/i;

const BLOCK_TAGS = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "ASIDE", "BLOCKQUOTE",
  "TABLE", "TR", "UL", "OL", "PRE", "FIGURE", "FIGCAPTION", "CENTER", "DL", "DT", "DD", "FORM",
]);
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "HEAD", "NOSCRIPT", "SVG", "IFRAME", "TEMPLATE", "BUTTON", "INPUT", "SELECT"]);

interface Options {
  keepLinks: boolean;
  baseUrl?: string;
}

export function htmlToText(html: string, opts: Options = { keepLinks: true }): ExtractedText {
  const dom = new JSDOM(html, { virtualConsole: new VirtualConsole(), ...(opts.baseUrl ? { url: opts.baseUrl } : {}) });
  return nodeToText(dom.window.document.body ?? dom.window.document.documentElement, opts);
}

export function nodeToText(root: Node, opts: Options): ExtractedText {
  const links: ExtractedLink[] = [];
  const urlToRef = new Map<string, string>();
  const out: string[] = [];
  let line = "";

  const flush = () => {
    const t = line.replace(/[ \t ]+/g, " ").trim();
    if (t) out.push(t);
    line = "";
  };
  const blank = () => {
    flush();
    if (out.length && out[out.length - 1] !== "") out.push("");
  };

  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      line += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return;
    const style = el.getAttribute("style") ?? "";
    if (/display\s*:\s*none|max-height\s*:\s*0|font-size\s*:\s*0/i.test(style)) return; // preheaders

    if (tag === "BR") {
      flush();
      return;
    }
    if (tag === "IMG") {
      const alt = el.getAttribute("alt")?.trim();
      if (alt && alt.length > 3 && el.parentElement?.tagName === "A") line += ` ${alt} `;
      return;
    }
    if (/^H[1-6]$/.test(tag)) {
      blank();
      line += "#".repeat(Number(tag[1])) + " ";
      el.childNodes.forEach(walk);
      blank();
      return;
    }
    if (tag === "LI") {
      flush();
      line += "- ";
      el.childNodes.forEach(walk);
      flush();
      return;
    }
    if (tag === "A" && opts.keepLinks) {
      const before = line.length;
      el.childNodes.forEach(walk);
      const linkText = line.slice(before).trim();
      const href = el.getAttribute("href");
      const url = href ? cleanUrl(opts.baseUrl ? new URL(href, opts.baseUrl).toString() : href) : null;
      if (url && linkText && !UNSUB_LINK_TEXT.test(linkText)) {
        let ref = urlToRef.get(url);
        if (!ref) {
          ref = `L${links.length + 1}`;
          urlToRef.set(url, ref);
          links.push({ ref, url, text: linkText.slice(0, 200) });
        }
        line += ` [${ref}]`;
      }
      return;
    }
    if (tag === "TD" || tag === "TH") {
      el.childNodes.forEach(walk);
      line += " ";
      return;
    }
    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) blank();
    el.childNodes.forEach(walk);
    if (isBlock) blank();
  };

  walk(root);
  flush();

  const cleaned = removeBoilerplate(out);
  return { text: cleaned, links: pruneLinks(cleaned, links) };
}

/** Drop footer boilerplate lines and sponsor blocks (heading + following paragraph(s)). */
function removeBoilerplate(lines: string[]): string {
  const result: string[] = [];
  let skippingSponsor = false;
  for (const l of lines) {
    const plain = l.replace(/^#+\s*/, "").replace(/\[L\d+\]/g, "").trim();
    if (l.startsWith("#")) skippingSponsor = SPONSOR_HEADING.test(plain);
    else if (SPONSOR_HEADING.test(plain) && plain.length < 80) {
      skippingSponsor = true;
      continue;
    }
    if (skippingSponsor) continue;
    if (BOILERPLATE_LINE.test(plain) && plain.length < 300) continue;
    if (!plain && l !== "") continue; // a line that was only link markers
    result.push(l);
  }
  return result
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function pruneLinks(text: string, links: ExtractedLink[]): ExtractedLink[] {
  const used = new Set(text.match(/\[L\d+\]/g)?.map((m) => m.slice(1, -1)));
  return links.filter((l) => used.has(l.ref));
}

/** Truncate to ~maxChars on a paragraph/line boundary. */
export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const cut = text.slice(0, maxChars);
  const idx = Math.max(cut.lastIndexOf("\n\n"), cut.lastIndexOf("\n"));
  return { text: (idx > maxChars * 0.7 ? cut.slice(0, idx) : cut).trimEnd() + "\n…（以下截斷）", truncated: true };
}

/** Plain-text mail: replace bare URLs with [Ln] markers and drop boilerplate lines. */
export function plainToText(body: string): ExtractedText {
  const links: ExtractedLink[] = [];
  const urlToRef = new Map<string, string>();
  const replaced = body.replace(/<?(https?:\/\/[^\s<>()\]]+)>?/g, (_m, raw: string) => {
    const url = cleanUrl(raw.replace(/[.,;:!?'"]+$/, ""));
    if (!url) return "";
    let ref = urlToRef.get(url);
    if (!ref) {
      ref = `L${links.length + 1}`;
      urlToRef.set(url, ref);
      links.push({ ref, url, text: "" });
    }
    return `[${ref}]`;
  });
  const text = removeBoilerplate(replaced.replace(/\r\n/g, "\n").split("\n").map((l) => l.trimEnd()));
  return { text, links: pruneLinks(text, links) };
}
