import "dotenv/config";
import { z } from "zod";

const intFromEnv = (def: number) =>
  z.coerce.number().int().positive().default(def);

export const DEFAULT_STYLE_PROMPT =
  "用台灣口音的國語，像一位輕鬆、有溫度的科技 Podcast 主持人在跟朋友聊天。語速自然、句子之間適度停頓、語調有起伏，不要像在念稿。英文技術名詞用自然的英文發音。";

const EnvSchema = z.object({
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REFRESH_TOKEN: z.string().min(1),
  GOOGLE_TTS_CREDENTIALS: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().min(1),
  CLAUDE_MODEL: z.string().min(1).default("claude-sonnet-5-5"),
  CLAUDE_CLASSIFY_MODEL: z.string().min(1).default("claude-haiku-5-5"),

  GMAIL_QUERY: z.string().min(1).default("is:unread newer_than:1d"),
  SKIP_CLASSIFY: z.enum(["auto", "true", "false"]).default("auto"),
  MAX_CANDIDATES: intFromEnv(50),
  MAX_EMAILS: intFromEnv(20),
  MAX_DEEP_ITEMS: intFromEnv(3),
  SCRIPT_TARGET_CHARS: intFromEnv(2800),

  TTS_MODEL: z.string().min(1).default("gemini-2.5-flash-tts"),
  TTS_VOICE: z.string().min(1).default("Kore"),
  TTS_LANGUAGE: z.string().min(1).default("cmn-TW"),
  TTS_STYLE_PROMPT: z.string().min(1).default(DEFAULT_STYLE_PROMPT),
  TTS_SPEAKING_RATE: z.coerce.number().min(0.25).max(4).default(1.1),
  TTS_PITCH: z.coerce.number().min(-20).max(20).default(0),
  RETENTION_DAYS: intFromEnv(7),
});

export type Config = ReturnType<typeof loadConfig>;

/** Read and validate env vars. Empty strings count as unset so defaults apply. */
export function loadConfig() {
  const raw = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== undefined && v.trim() !== ""),
  );
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    // Only print variable names, never values.
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))];
    throw new Error(`環境變數缺少或格式錯誤：${names.join(", ")}（請參考 .env.example）`);
  }
  const env = parsed.data;
  const skipClassify =
    env.SKIP_CLASSIFY === "auto" ? /\blabel:/i.test(env.GMAIL_QUERY) : env.SKIP_CLASSIFY === "true";
  // TTS_MODEL=none switches back to the classic voices (e.g. cmn-TW-Wavenet-A).
  const ttsModel = env.TTS_MODEL.toLowerCase() === "none" ? null : env.TTS_MODEL;
  if (ttsModel && env.TTS_VOICE.includes("-")) {
    throw new Error(
      `TTS_VOICE=${env.TTS_VOICE} 是舊式語音，不能搭配 Gemini-TTS（TTS_MODEL=${ttsModel}）。` +
        "請改成 Gemini 語音名稱（例如 Kore），或設定 TTS_MODEL=none 繼續使用舊語音",
    );
  }
  return { ...env, skipClassify, ttsModel };
}

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  project_id?: string;
}

/**
 * GOOGLE_TTS_CREDENTIALS holds the service-account key JSON, either as-is
 * (single line) or base64-encoded. Only needed when audio is generated.
 */
export function ttsCredentials(config: Pick<Config, "GOOGLE_TTS_CREDENTIALS">): ServiceAccountKey {
  const raw = config.GOOGLE_TTS_CREDENTIALS?.trim();
  if (!raw) throw new Error("產生音檔需要設定 GOOGLE_TTS_CREDENTIALS（服務帳戶金鑰 JSON）");
  const json = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  let key: Partial<ServiceAccountKey>;
  try {
    key = JSON.parse(json);
  } catch {
    throw new Error("GOOGLE_TTS_CREDENTIALS 不是有效的 JSON（或 base64 編碼的 JSON）");
  }
  if (!key.client_email || !key.private_key) {
    throw new Error("GOOGLE_TTS_CREDENTIALS 缺少 client_email 或 private_key");
  }
  return key as ServiceAccountKey;
}

/** Only the Google OAuth client is needed for `npm run auth`. */
export function loadAuthConfig() {
  const id = process.env.GOOGLE_CLIENT_ID?.trim();
  const secret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!id || !secret) {
    throw new Error("請先在 .env 設定 GOOGLE_CLIENT_ID 與 GOOGLE_CLIENT_SECRET");
  }
  return { clientId: id, clientSecret: secret };
}

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/drive.file",
];

export const TIME_ZONE = "Asia/Taipei";
