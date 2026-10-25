// F1-2 (classification from metadata only) and F1-4 (newsletter sender list).
import { readFile } from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import * as z from "zod";
import { callStructured, UNTRUSTED_NOTICE } from "./claude.js";
import type { Config } from "./config.js";
import type { CandidateMeta } from "./gmail.js";
import { escapeAttr, escapeTag, OUTPUT_ROOT, taipeiDate, writeOutput } from "./util.js";

export type Category = "tech_newsletter" | "news" | "other_bulk" | "personal" | "not_bulk";

/** Categories whose content goes into the episode. */
export const EPISODE_CATEGORIES: readonly Category[] = ["tech_newsletter", "news"];

export interface ClassifiedMail extends CandidateMeta {
  category: Category;
  reason: string;
}

const ClassifySchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      category: z.enum(["tech_newsletter", "news", "other_bulk", "personal"]),
      reason: z.string().describe("一句話說明判斷依據"),
    }),
  ),
});

const SYSTEM = `你是郵件分類器。根據每封信的中繼資料（寄件者、主旨、Gmail 分類、摘要片段），把信分成四類：
- tech_newsletter：技術新知、開發者電子報、資安通報、AI 新聞、技術部落格文章摘要等以「傳遞技術新知」為主的定期寄送內容。
- news：一般新聞，例如新聞媒體寄送的時事、國際、財經、社會、台灣在地新聞摘要或快報。AI 或技術新聞歸 tech_newsletter，不算 news。
- other_bulk：行銷促銷、產品廣告、活動報名、帳單、收據、交易或出貨通知、帳號安全通知、社群網站通知等。
- personal：個人或工作往來信件（例如同事、朋友、客戶寄來的信）。
判斷原則：技術公司寄的純促銷或帳務通知算 other_bulk，不算 tech_newsletter；新聞媒體寄的訂閱促銷、活動廣告也算 other_bulk，不算 news。拿不準時偏向 other_bulk。
每封信都必須輸出一筆結果，id 要與輸入完全相同。

${UNTRUSTED_NOTICE}`;

function renderEmails(mails: CandidateMeta[]): string {
  return mails
    .map(
      (m) =>
        `<email id="${escapeAttr(m.id)}">\n寄件者：${escapeTag(m.fromName)} <${escapeTag(m.fromAddress)}>\n主旨：${escapeTag(m.subject)}\nGmail 分類：${m.categories.join(", ") || "無"}\n摘要片段：${escapeTag(m.snippet)}\n</email>`,
    )
    .join("\n\n");
}

export async function classify(
  client: Anthropic,
  config: Config,
  candidates: CandidateMeta[],
): Promise<ClassifiedMail[]> {
  if (config.skipClassify) {
    // Label mode: everything the query returns is treated as a newsletter.
    return candidates.map((c) => ({ ...c, category: "tech_newsletter", reason: "標籤模式，略過分類" }));
  }

  // Rule pre-filter: only bulk mail (List-Unsubscribe / List-Id) goes to Claude.
  const bulk = candidates.filter((c) => c.hasListUnsubscribe || c.hasListId);
  const byId = new Map<string, { category: Category; reason: string }>();

  if (bulk.length) {
    const out = await callStructured(client, {
      label: "分類",
      model: config.CLAUDE_CLASSIFY_MODEL,
      system: SYSTEM,
      user: `請分類以下 ${bulk.length} 封信：\n\n${renderEmails(bulk)}`,
      schema: ClassifySchema,
      maxTokens: 16000,
      effort: "low",
    });
    for (const r of out.results) byId.set(r.id, { category: r.category, reason: r.reason });
  }

  return candidates.map((c) => {
    if (!(c.hasListUnsubscribe || c.hasListId)) {
      return { ...c, category: "not_bulk", reason: "沒有 List-Unsubscribe / List-Id 標頭" };
    }
    // A bulk mail Claude skipped is treated as other_bulk (never sent onward).
    return { ...c, ...(byId.get(c.id) ?? { category: "other_bulk", reason: "分類結果缺漏" }) };
  });
}

// ----- F1-4 -----

interface SenderEntry {
  name: string;
  /** Latest category seen for this sender. Missing on entries written before news was added. */
  category?: Category;
  count: number;
  firstSeen: string;
  lastSeen: string;
}
interface SenderFile {
  updatedAt: string;
  senders: Record<string, SenderEntry>;
  /** Recently counted message ids, so re-running the same day does not double count. */
  countedMessageIds: string[];
}

export const SENDERS_FILE = "newsletter-senders.json";

export async function updateSenderList(mails: ClassifiedMail[]): Promise<number> {
  const file = path.join(OUTPUT_ROOT, SENDERS_FILE);
  let data: SenderFile = { updatedAt: "", senders: {}, countedMessageIds: [] };
  try {
    data = JSON.parse(await readFile(file, "utf8")) as SenderFile;
  } catch {
    // First run (or no artifact restored yet).
  }
  const counted = new Set(data.countedMessageIds);
  const today = taipeiDate();
  for (const m of mails) {
    if (!EPISODE_CATEGORIES.includes(m.category) || counted.has(m.id)) continue;
    counted.add(m.id);
    const e = data.senders[m.fromAddress];
    if (e) {
      e.count += 1;
      e.name = m.fromName;
      e.category = m.category;
      e.lastSeen = today;
    } else {
      data.senders[m.fromAddress] = {
        name: m.fromName,
        category: m.category,
        count: 1,
        firstSeen: today,
        lastSeen: today,
      };
    }
  }
  data.updatedAt = new Date().toISOString();
  data.countedMessageIds = [...counted].slice(-2000);
  data.senders = Object.fromEntries(
    Object.entries(data.senders).sort(([, a], [, b]) => b.count - a.count),
  );
  await writeOutput(SENDERS_FILE, data);
  return Object.keys(data.senders).length;
}
