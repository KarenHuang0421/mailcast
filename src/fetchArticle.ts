// F3: fetch the original article for deep items and extract the main text with Readability.
// Failures (paywall, login, timeout) are not fatal: the item falls back to the newsletter summary.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import type { NewsItem } from "./analyze.js";
import { htmlToText, truncate } from "./htmlText.js";

export interface ArticleResult {
  itemId: string;
  ok: boolean;
  url?: string;
  title?: string;
  text?: string;
  error?: string;
}

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_ARTICLE_CHARS = 12_000;
const MIN_ARTICLE_CHARS = 300;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  );
}

/** Links come from untrusted mail: refuse non-http(s) and private/loopback targets. */
async function assertPublicUrl(url: URL) {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("不支援的協定");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addrs.some(isPrivateAddress)) throw new Error("拒絕存取內部網路位址");
}

async function readLimited(res: Response): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new Error("網頁過大");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function decodeHtml(bytes: Uint8Array, contentType: string): string {
  const head = new TextDecoder("latin1").decode(bytes.slice(0, 4096));
  const charset =
    contentType.match(/charset="?([^";\s]+)/i)?.[1] ??
    head.match(/<meta[^>]+charset=["']?([^"'\s/>;]+)/i)?.[1] ??
    "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

async function fetchHtml(startUrl: string): Promise<{ url: string; html: string }> {
  let url = new URL(startUrl);
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(url);
    const res = await fetch(url, {
      redirect: "manual",
      signal,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, url);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get("content-type") ?? "";
    if (!/html|xml/i.test(ct)) throw new Error(`非網頁內容（${ct.split(";")[0] || "unknown"}）`);
    return { url: url.toString(), html: decodeHtml(await readLimited(res), ct) };
  }
  throw new Error("重新導向次數過多");
}

async function fetchOne(url: string): Promise<{ url: string; title: string; text: string }> {
  const page = await fetchHtml(url);
  const dom = new JSDOM(page.html, { url: page.url, virtualConsole: new VirtualConsole() });
  const article = new Readability(dom.window.document).parse();
  if (!article?.content) throw new Error("擷取不到正文");
  const { text } = htmlToText(article.content, { keepLinks: false });
  if (text.length < MIN_ARTICLE_CHARS) throw new Error("正文過短（可能需要登入或有付費牆）");
  return { url: page.url, title: article.title ?? "", text: truncate(text, MAX_ARTICLE_CHARS).text };
}

/** Try each candidate link of every deep item (in parallel per item). Never throws. */
export async function fetchArticles(items: NewsItem[]): Promise<ArticleResult[]> {
  return Promise.all(
    items.map(async (item): Promise<ArticleResult> => {
      const errors: string[] = [];
      for (const link of item.links.slice(0, 2)) {
        try {
          const a = await fetchOne(link);
          return { itemId: item.id, ok: true, ...a };
        } catch (e) {
          errors.push(e instanceof Error ? (e.name === "TimeoutError" ? "逾時" : e.message) : String(e));
        }
      }
      return { itemId: item.id, ok: false, error: errors.join("; ") || "沒有原文連結" };
    }),
  );
}
