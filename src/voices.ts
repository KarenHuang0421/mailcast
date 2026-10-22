// `npm run voices`: list the Taiwanese Mandarin voices available to the TTS service account.
// `npm run voices -- --sample`: synthesize a short sample with several voices to compare.
import "dotenv/config";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_STYLE_PROMPT } from "./config.js";
import { createTtsClient, encodeMp3, synthesizeChunk, type TtsConfig } from "./tts.js";
import { OUTPUT_ROOT } from "./util.js";

const SAMPLE_TEXT =
  "早安，歡迎收聽 mailcast。今天是十月二十二日，我們收到了六封技術電子報。" +
  "先來聊一個資安話題，最近又有團隊發現新的 Prompt Injection 手法，攻擊者把指令藏在網頁裡，" +
  "等 AI Agent 去讀的時候就中招了。如果你有在用 React 或 Angular 串接 LLM 的 API，這件事其實跟你蠻有關係的。";

const SAMPLE_VOICES: { model: string | null; voice: string }[] = [
  // { model: "gemini-2.5-flash-tts", voice: "Kore" },
  // { model: "gemini-2.5-flash-tts", voice: "Aoede" },
  // { model: "gemini-2.5-flash-tts", voice: "Puck" },
  // { model: "gemini-2.5-flash-tts", voice: "Charon" },
  { model: "gemini-3.1-flash-tts-preview", voice: "Sadaltager" },
  { model: "gemini-3.1-flash-tts-preview", voice: "Algenib" },
  { model: "gemini-3.1-flash-tts-preview", voice: "Rasalgethi" },
  { model: "gemini-3.1-flash-tts-preview", voice: "Gacrux" },
  { model: "gemini-3.1-flash-tts-preview", voice: "Pulcherrima" },
  { model: "gemini-3.1-flash-tts-preview", voice: "Sulafat" },
  // { model: null, voice: "cmn-TW-Wavenet-A" },
];

async function listVoices(tts: ReturnType<typeof createTtsClient>) {
  const res = await tts.voices.list({ languageCode: "cmn-TW" });
  const voices = (res.data.voices ?? []).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  for (const v of voices) console.log(`${v.name}\t${v.ssmlGender}`);
  console.log(`\n共 ${voices.length} 個。把想用的名稱填進 .env 的 TTS_VOICE。`);
  console.log("Gemini-TTS 的語音（Kore、Aoede、Puck、Charon 等）可用 --sample 試聽。");
}

async function sample(tts: ReturnType<typeof createTtsClient>) {
  const dir = path.join(OUTPUT_ROOT, "voice-samples");
  await mkdir(dir, { recursive: true });
  for (const { model, voice } of SAMPLE_VOICES) {
    const config: TtsConfig = {
      GOOGLE_TTS_CREDENTIALS: process.env.GOOGLE_TTS_CREDENTIALS,
      ttsModel: model,
      TTS_VOICE: voice,
      TTS_LANGUAGE: "cmn-TW",
      TTS_STYLE_PROMPT: process.env.TTS_STYLE_PROMPT?.trim() || DEFAULT_STYLE_PROMPT,
      TTS_SPEAKING_RATE: 1.0,
      TTS_PITCH: 0,
    };
    const file = path.join(dir, `${voice}.mp3`);
    try {
      const pcm = await synthesizeChunk(tts, config, SAMPLE_TEXT);
      await encodeMp3(pcm, file, `mailcast sample ${voice}`);
      console.log(`✓ ${voice}${model ? `（${model}）` : ""}：${file}`);
    } catch (e) {
      console.log(`✗ ${voice}：${e instanceof Error ? e.message : e}`);
    }
  }
  console.log("\n試聽後把喜歡的語音填進 .env 的 TTS_VOICE（舊式語音需同時設定 TTS_MODEL=none）。");
}

async function main() {
  const tts = createTtsClient({ GOOGLE_TTS_CREDENTIALS: process.env.GOOGLE_TTS_CREDENTIALS });
  if (process.argv.includes("--sample")) await sample(tts);
  else await listVoices(tts);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
