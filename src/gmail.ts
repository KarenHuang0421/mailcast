// F1-1 (candidate metadata) and F1-3 (newsletter bodies). Read-only: only list/get calls.
import { google, type gmail_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { htmlToText, plainToText, pruneLinks, truncate, type ExtractedLink } from "./htmlText.js";
import { taipeiDateTime, withRetry } from "./util.js";

export interface CandidateMeta {
  id: string;
  fromName: string;
  fromAddress: string;
  subject: string;
  receivedAt: string; // Asia/Taipei, "YYYY-MM-DD HH:mm"
  snippet: string;
  categories: string[]; // e.g. CATEGORY_PROMOTIONS, CATEGORY_UPDATES
  hasListUnsubscribe: boolean;
  hasListId: boolean;
}

export interface Newsletter {
  id: string; // short id used in prompts, e.g. "n1"
  messageId: string;
  sender: string;
  fromAddress: string;
  subject: string;
  receivedAt: string;
  text: string;
  truncated: boolean;
  links: ExtractedLink[];
}

const MAX_BODY_CHARS = 8000;

export function gmailClient(auth: OAuth2Client) {
  return google.gmail({ version: "v1", auth });
}

function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string) {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function parseFrom(from: string): { name: string; address: string } {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || m[2].trim(), address: m[2].trim().toLowerCase() };
  return { name: from.trim(), address: from.trim().toLowerCase() };
}

function decodeHtmlEntities(s: string) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** F1-1: list candidate messages and fetch metadata only (no bodies). */
export async function listCandidates(
  gmail: gmail_v1.Gmail,
  query: string,
  max: number,
): Promise<CandidateMeta[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await withRetry("Gmail 列表", () =>
      gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults: Math.min(100, max - ids.length),
        pageToken,
      }),
    );
    for (const m of res.data.messages ?? []) if (m.id) ids.push(m.id);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && ids.length < max);

  const metas: CandidateMeta[] = [];
  for (const id of ids.slice(0, max)) {
    const res = await withRetry("Gmail 中繼資料", () =>
      gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "List-Unsubscribe", "List-Id"],
      }),
    );
    const msg = res.data;
    const headers = msg.payload?.headers ?? undefined;
    const from = parseFrom(header(headers, "From"));
    metas.push({
      id,
      fromName: from.name,
      fromAddress: from.address,
      subject: header(headers, "Subject"),
      receivedAt: taipeiDateTime(new Date(Number(msg.internalDate ?? Date.now()))),
      snippet: decodeHtmlEntities(msg.snippet ?? ""),
      categories: (msg.labelIds ?? []).filter((l) => l.startsWith("CATEGORY_")),
      hasListUnsubscribe: header(headers, "List-Unsubscribe") !== "",
      hasListId: header(headers, "List-Id") !== "",
    });
  }
  return metas;
}

function decodePart(part: gmail_v1.Schema$MessagePart): string {
  const data = part.body?.data;
  if (!data) return "";
  const bytes = Buffer.from(data, "base64url");
  const ct = header(part.headers ?? undefined, "Content-Type") || part.mimeType || "";
  const charset = ct.match(/charset="?([^";\s]+)"?/i)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function findPart(part: gmail_v1.Schema$MessagePart, mime: string): gmail_v1.Schema$MessagePart | undefined {
  if (part.mimeType === mime && part.body?.data && !part.filename) return part;
  for (const p of part.parts ?? []) {
    const found = findPart(p, mime);
    if (found) return found;
  }
  return undefined;
}

/** F1-3: fetch the full body of one newsletter and convert it to structured text. */
export async function fetchNewsletter(
  gmail: gmail_v1.Gmail,
  meta: CandidateMeta,
  shortId: string,
): Promise<Newsletter> {
  const res = await withRetry("Gmail 內文", () =>
    gmail.users.messages.get({ userId: "me", id: meta.id, format: "full" }),
  );
  const payload = res.data.payload ?? {};
  const html = findPart(payload, "text/html");
  const plain = findPart(payload, "text/plain");
  const extracted = html
    ? htmlToText(decodePart(html), { keepLinks: true })
    : plain
      ? plainToText(decodePart(plain))
      : { text: meta.snippet, links: [] };

  const { text, truncated } = truncate(extracted.text, MAX_BODY_CHARS);
  return {
    id: shortId,
    messageId: meta.id,
    sender: meta.fromName,
    fromAddress: meta.fromAddress,
    subject: meta.subject,
    receivedAt: meta.receivedAt,
    text,
    truncated,
    links: pruneLinks(text, extracted.links),
  };
}
