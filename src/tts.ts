// F5: script → mp3.
// Each section is split into chunks on sentence boundaries and synthesized as
// LINEAR16 PCM. The PCM is joined with silence (short between chunks, longer
// between sections), then encoded once to mp3 by ffmpeg, which also writes the
// ID3 tags. Encoding once avoids the wrong-duration problem of gluing mp3 files.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { google } from "googleapis";
import { ttsCredentials, type Config } from "./config.js";
import type { Script } from "./script.js";
import { OUTPUT_ROOT, withRetry } from "./util.js";

const SAMPLE_RATE = 24_000;
const BYTES_PER_SAMPLE = 2; // 16-bit mono
/** API limit is 5,000 bytes of input; stay well below it (≈1,000 CJK chars). */
const MAX_CHUNK_BYTES = 3000;

/** Gemini-TTS is in preview with tighter rate limits. */
const CONCURRENCY = 2;

const PAUSE_LEAD_MS = 300;
const PAUSE_CHUNK_MS = 300;
const PAUSE_SECTION_MS = 1200;
const PAUSE_TAIL_MS = 1000;

export interface AudioResult {
  file: string;
  seconds: number;
  chunks: number;
}

const byteLen = (s: string) => Buffer.byteLength(s, "utf8");

/** Split text into pieces under maxBytes, preferring sentence, then clause, boundaries. */
export function splitText(text: string, maxBytes = MAX_CHUNK_BYTES): string[] {
  const sentences = text.match(/[^。！？!?；;\n]+[。！？!?；;」』）)]*|\n+/g) ?? [text];
  const pieces: string[] = [];
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (byteLen(s) <= maxBytes) {
      pieces.push(s);
      continue;
    }
    // Over-long sentence: split on commas, then hard-split as a last resort.
    for (const clause of s.match(/[^，,、：:]+[，,、：:]?/g) ?? [s]) {
      if (byteLen(clause) <= maxBytes) {
        pieces.push(clause);
        continue;
      }
      let cur = "";
      for (const ch of clause) {
        if (byteLen(cur + ch) > maxBytes) {
          pieces.push(cur);
          cur = "";
        }
        cur += ch;
      }
      if (cur) pieces.push(cur);
    }
  }

  // Greedily pack pieces back together up to the limit.
  const chunks: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (cur && byteLen(cur + p) > maxBytes) {
      chunks.push(cur);
      cur = "";
    }
    cur += p;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Extract the PCM samples from a WAV (RIFF) buffer and check the format. */
export function wavToPcm(wav: Buffer): Buffer {
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("TTS 回傳的不是 WAV 格式");
  }
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      const channels = wav.readUInt16LE(body + 2);
      const rate = wav.readUInt32LE(body + 4);
      const bits = wav.readUInt16LE(body + 14);
      if (channels !== 1 || rate !== SAMPLE_RATE || bits !== 16) {
        throw new Error(`TTS 音訊格式不符（${channels} ch / ${rate} Hz / ${bits} bit）`);
      }
    } else if (id === "data") {
      return wav.subarray(body, Math.min(wav.length, body + size));
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV 中找不到音訊資料");
}

const silence = (ms: number) =>
  Buffer.alloc(Math.round((SAMPLE_RATE * ms) / 1000) * BYTES_PER_SAMPLE);

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

function languageCode(voice: string) {
  return voice.split("-").slice(0, 2).join("-"); // "cmn-TW-Wavenet-A" → "cmn-TW"
}

export type TtsConfig = Pick<
  Config,
  | "GOOGLE_TTS_CREDENTIALS"
  | "ttsModel"
  | "TTS_VOICE"
  | "TTS_LANGUAGE"
  | "TTS_STYLE_PROMPT"
  | "TTS_SPEAKING_RATE"
  | "TTS_PITCH"
>;

export function createTtsClient(config: Pick<Config, "GOOGLE_TTS_CREDENTIALS">) {
  const key = ttsCredentials(config);
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: key.client_email, private_key: key.private_key },
    projectId: key.project_id,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  return google.texttospeech({ version: "v1", auth });
}

type TtsClient = ReturnType<typeof createTtsClient>;

/** Synthesize one chunk (≤ MAX_CHUNK_BYTES) to 24 kHz mono PCM. */
export async function synthesizeChunk(tts: TtsClient, config: TtsConfig, text: string): Promise<Buffer> {
  const audioEncoding = { audioEncoding: "LINEAR16", sampleRateHertz: SAMPLE_RATE };
  const requestBody = config.ttsModel
    ? {
        // Gemini-TTS: tone and pace come from the style prompt, not speakingRate/pitch.
        input: { text, prompt: config.TTS_STYLE_PROMPT },
        voice: { languageCode: config.TTS_LANGUAGE, name: config.TTS_VOICE, modelName: config.ttsModel },
        audioConfig: audioEncoding,
      }
    : {
        input: { text },
        voice: { languageCode: languageCode(config.TTS_VOICE), name: config.TTS_VOICE },
        audioConfig: {
          ...audioEncoding,
          speakingRate: config.TTS_SPEAKING_RATE,
          // Some voices reject pitch entirely, so only send it when it is set.
          ...(config.TTS_PITCH !== 0 ? { pitch: config.TTS_PITCH } : {}),
        },
      };
  const res = await withRetry("TTS 合成", () => tts.text.synthesize({ requestBody }));
  if (!res.data.audioContent) throw new Error("TTS 沒有回傳音訊");
  return wavToPcm(Buffer.from(res.data.audioContent, "base64"));
}

export async function encodeMp3(pcm: Buffer, file: string, title: string) {
  if (!ffmpegPath) throw new Error("找不到 ffmpeg（ffmpeg-static 安裝失敗？）");
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "1", "-i", "pipe:0",
    "-codec:a", "libmp3lame", "-b:a", "64k",
    "-id3v2_version", "3",
    "-metadata", `title=${title}`,
    "-metadata", "artist=mailcast",
    "-metadata", "album=mailcast",
    file,
  ];
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegPath as unknown as string, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg 編碼失敗（${code}）：${stderr.slice(0, 500)}`)),
    );
    proc.stdin.on("error", reject);
    proc.stdin.end(pcm);
  });
}

export async function synthesize(config: Config, script: Script, date: string): Promise<AudioResult> {
  const tts = createTtsClient(config);

  const sections = script.sections.map((s) => splitText(s.text));
  const jobs = sections.flatMap((chunks, si) => chunks.map((text, ci) => ({ si, ci, text })));

  const pcmChunks = await mapLimit(jobs, CONCURRENCY, (job) => synthesizeChunk(tts, config, job.text));

  // Reassemble in order with pauses.
  const parts: Buffer[] = [silence(PAUSE_LEAD_MS)];
  let j = 0;
  sections.forEach((chunks, si) => {
    if (si > 0) parts.push(silence(PAUSE_SECTION_MS));
    chunks.forEach((_, ci) => {
      if (ci > 0) parts.push(silence(PAUSE_CHUNK_MS));
      parts.push(pcmChunks[j++]);
    });
  });
  parts.push(silence(PAUSE_TAIL_MS));
  const pcm = Buffer.concat(parts);

  const file = path.join(OUTPUT_ROOT, date, `mailcast-${date}.mp3`);
  await mkdir(path.dirname(file), { recursive: true });
  await encodeMp3(pcm, file, `mailcast ${date}`);

  return { file, seconds: pcm.length / BYTES_PER_SAMPLE / SAMPLE_RATE, chunks: jobs.length };
}

export function formatDuration(seconds: number) {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}
