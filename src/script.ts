// F4: write the podcast script from the scored items and fetched articles.
import type Anthropic from "@anthropic-ai/sdk";
import * as z from "zod";
import type { NewsItem } from "./analyze.js";
import { callStructured, UNTRUSTED_NOTICE } from "./claude.js";
import type { Config } from "./config.js";
import type { ArticleResult } from "./fetchArticle.js";
import { escapeAttr, escapeTag } from "./util.js";

export type SectionKind = "opening" | "brief" | "deep" | "closing";

export interface ScriptSection {
  kind: SectionKind;
  text: string;
}

export interface Script {
  sections: ScriptSection[];
  /** Number of characters excluding whitespace. */
  chars: number;
  /** Things the sanitizer had to strip (should be 0; >0 means the prompt needs tuning). */
  sanitized: number;
}

const ScriptSchema = z.object({
  sections: z
    .array(
      z.object({
        kind: z.enum(["opening", "brief", "deep", "closing"]),
        text: z.string().describe("這一段要唸出來的純文字"),
      }),
    )
    .describe("依序：一個 opening、一個 brief（所有快速新知）、每則深入解說各一個 deep、一個 closing"),
});

function buildSystem(targetChars: number) {
  return `你是一位懂技術的中文 Podcast 主持人，節目叫 mailcast，每天早上幫聽眾整理技術電子報的重點。聽眾是一位有經驗的前端工程師，會在通勤時收聽。你寫的稿子會直接交給語音合成唸出來。

節目結構（依序輸出成 sections）：
1. opening（約十五秒）：問候、今天的日期、今天收到幾封技術電子報、預告今天要深入聊哪幾個主題。
2. brief：快速新知。把所有 brief 項目串成一段自然的口播，每則一兩句話，說清楚「發生了什麼」。項目之間用自然的轉場語連接。沒有 brief 項目時省略這一段。
3. deep：每則深入解說各一個 section，每則約一到兩分鐘，內容包含：
   - 這是什麼：必要時補充背景知識，假設聽眾是有經驗的前端工程師，但不熟這個領域。
   - 為什麼重要、影響是什麼。
   - 跟聽眾可能的關聯，例如對前端開發、AI 應用開發或資安學習的意義。
4. closing：用一句話總結今天最值得記住的一件事；如果有值得回去看原文的，提醒是哪一篇（用電子報名稱或文章標題描述，不要唸網址）。若資料中有一般未讀信的數量，在這裡順帶提一句還有幾封一般未讀信，不要提任何寄件者或主旨。最後簡短道別。

寫作要求：
- 使用繁體中文與台灣用語，口語化、自然，像主持人在跟聽眾聊天，不要像在念新聞稿。
- 句子要短，一句盡量不超過三十個字，多用逗號斷句，讓語音合成有自然的換氣點。
- 可以適度加入口語的語助詞或轉折，例如「其實」、「你可以想像一下」、「那這代表什麼呢」，但不要每句都加。
- 技術專有名詞保留英文原文，例如 React、API、Prompt Injection、CVE，不要硬翻成中文。
- 嚴格禁止出現 Markdown、條列符號、編號清單、表情符號、網址、電子郵件地址、括號註解。不要使用星號、井字號、破折號開頭的列點。
- 數字與日期要寫成適合朗讀的形式，例如「十月二十二日」、「三點五倍」、「兩千四百萬」；版本號可以寫成「十九點一版」或「React 19」這種唸得順的形式。
- 深入解說要以 <article> 原文與電子報內容為主。補充的背景知識必須是公認的常識，不得編造數據、版本號、發布日期或引述。原文沒寫、你也不確定的地方，直接說不確定或還沒有公布。
- 如果某則深入解說的原文抓取失敗，只能根據電子報摘要來講，並在解說中自然帶過「電子報提供的資訊有限」，不要自行腦補細節。
- 全文長度目標約 ${targetChars} 字（約八到十分鐘），深入解說占大部分篇幅。

${UNTRUSTED_NOTICE}`;
}

interface ScriptInput {
  dateLong: string;
  newsletterCount: number;
  generalMailCount: number | null;
  items: NewsItem[];
  articles: ArticleResult[];
}

function renderInput(input: ScriptInput): string {
  const brief = input.items.filter((i) => i.tier === "brief");
  const deep = input.items.filter((i) => i.tier === "deep");
  const articleById = new Map(input.articles.map((a) => [a.itemId, a]));

  const briefXml = brief
    .map(
      (i) =>
        `<item title="${escapeAttr(i.title)}" sources="${i.sourceCount}">${escapeTag(i.summary)}</item>`,
    )
    .join("\n");

  const deepXml = deep
    .map((i) => {
      const a = articleById.get(i.id);
      const article = a?.ok
        ? `<article title="${escapeAttr(a.title ?? "")}">\n${escapeTag(a.text ?? "")}\n</article>`
        : `<article status="unavailable">原文抓取失敗，只能使用電子報摘要。</article>`;
      const srcs = i.sources.map((s) => s.newsletter).join("、");
      return `<deep_item title="${escapeAttr(i.title)}" sources="${escapeAttr(srcs)}">\n<newsletter_summary>${escapeTag(i.summary)}</newsletter_summary>\n${article}\n</deep_item>`;
    })
    .join("\n\n");

  return [
    `今天日期：${input.dateLong}`,
    `今天的技術電子報數量：${input.newsletterCount} 封`,
    input.generalMailCount === null ? "" : `一般未讀信數量：${input.generalMailCount} 封`,
    "",
    `<brief_items count="${brief.length}">\n${briefXml}\n</brief_items>`,
    "",
    `<deep_items count="${deep.length}">\n${deepXml}\n</deep_items>`,
    "",
    "請依照節目結構寫出今天的廣播稿。",
  ]
    .filter((l, idx, arr) => !(l === "" && arr[idx - 1] === ""))
    .join("\n");
}

/** Safety net for anything the prompt didn't prevent. Returns cleaned text and number of fixes. */
export function sanitizeForSpeech(text: string): { text: string; fixes: number } {
  let fixes = 0;
  const rules: [RegExp, string][] = [
    [/https?:\/\/\S+|www\.\S+/gi, ""],
    [/\S+@\S+\.\w+/g, ""],
    [/^\s*(?:[-*•‧·]|\d+[.)、])\s+/gm, ""],
    [/^#+\s*/gm, ""],
    [/\*\*|__|`+|\[|\]/g, ""],
    [/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, ""],
  ];
  let out = text;
  for (const [re, rep] of rules) {
    out = out.replace(re, () => {
      fixes++;
      return rep;
    });
  }
  return { text: out.replace(/[ \t]{2,}/g, " ").trim(), fixes };
}

function countChars(sections: ScriptSection[]) {
  return sections.reduce((n, s) => n + s.text.replace(/\s/g, "").length, 0);
}

export async function writeScript(
  client: Anthropic,
  config: Config,
  input: ScriptInput,
): Promise<Script> {
  const out = await callStructured(client, {
    label: "廣播稿",
    model: config.CLAUDE_MODEL,
    system: buildSystem(config.SCRIPT_TARGET_CHARS),
    user: renderInput(input),
    schema: ScriptSchema,
    maxTokens: 64000,
  });
  let sanitized = 0;
  const sections = out.sections
    .map((s) => {
      const { text, fixes } = sanitizeForSpeech(s.text);
      sanitized += fixes;
      return { kind: s.kind, text };
    })
    .filter((s) => s.text.length > 0);
  return { sections, chars: countChars(sections), sanitized };
}

/** Short (~25 s) episode when there are no newsletters today. No Claude call needed. */
export function emptyScript(dateLong: string, generalMailCount: number | null): Script {
  const date = dateLong.replace(/^\d{4}年/, "");
  const general =
    generalMailCount && generalMailCount > 0
      ? `另外提醒你，信箱裡還有 ${toSpokenNumber(generalMailCount)} 封一般未讀信，有空的時候可以看一下。`
      : "";
  const sections: ScriptSection[] = [
    {
      kind: "opening",
      text: `早安，歡迎收聽 mailcast。今天是${date}。今天的信箱比較安靜，沒有收到新的技術電子報，所以這一集就簡短一點。`,
    },
    {
      kind: "closing",
      text: `${general}趁著通勤的時間，不妨放空一下，或是回頭複習最近幾天聽到的主題，想想有沒有哪一個值得找時間動手試試看。我們明天早上再見，祝你有美好的一天。`,
    },
  ];
  return { sections, chars: countChars(sections), sanitized: 0 };
}

function toSpokenNumber(n: number): string {
  const digits = "零一二三四五六七八九";
  if (n < 10) return n === 2 ? "兩" : digits[n];
  if (n < 20) return "十" + (n % 10 ? digits[n % 10] : "");
  if (n < 100) return digits[Math.floor(n / 10)] + "十" + (n % 10 ? digits[n % 10] : "");
  return String(n);
}

export function scriptToText(script: Script): string {
  return script.sections.map((s) => s.text).join("\n\n") + "\n";
}
