import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { TIME_ZONE } from "./config.js";

/** Status-only logging. Never pass mail content, script text or secrets here. */
export function log(message: string) {
  const time = new Date().toLocaleTimeString("zh-TW", { timeZone: TIME_ZONE, hour12: false });
  console.log(`[${time}] ${message}`);
}

/** YYYY-MM-DD in Asia/Taipei. */
export function taipeiDate(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function taipeiDateTime(d: Date): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: TIME_ZONE,
    dateStyle: "short",
    timeStyle: "short",
  }).format(d);
}

/** e.g. 2026年10月22日（星期四） — used as input for the script writer. */
export function taipeiDateLong(d = new Date()): string {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(d);
}

export const OUTPUT_ROOT = path.resolve("output");

export async function writeOutput(relPath: string, data: unknown): Promise<string> {
  const file = path.join(OUTPUT_ROOT, relPath);
  await mkdir(path.dirname(file), { recursive: true });
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n";
  await writeFile(file, body, "utf8");
  return file;
}

function errorStatus(err: unknown): number | undefined {
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const v of [e?.status, e?.response?.status, e?.code]) {
    if (typeof v === "number") return v;
    if (typeof v === "string" && /^\d{3}$/.test(v)) return Number(v);
  }
  return undefined;
}

/** Retry on 429 / 5xx / network errors with exponential backoff (1s, 2s, 4s). */
export async function withRetry<T>(label: string, fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = errorStatus(err);
      const retryable = status === undefined || status === 429 || status >= 500;
      if (!retryable || attempt >= retries) throw err;
      const delay = 1000 * 2 ** attempt;
      log(`${label} 失敗（${status ?? "network"}），${delay / 1000} 秒後重試（${attempt + 1}/${retries}）`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** Escape text placed inside XML-ish tags so untrusted content cannot close them. */
export function escapeTag(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttr(s: string): string {
  return escapeTag(s).replace(/"/g, "&quot;");
}
