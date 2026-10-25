// F2: split newsletters into news items, merge duplicates, score against interests.md.
import type Anthropic from "@anthropic-ai/sdk";
import * as z from "zod";
import { callStructured, UNTRUSTED_NOTICE } from "./claude.js";
import type { Config } from "./config.js";
import type { Newsletter } from "./gmail.js";
import { escapeAttr, escapeTag } from "./util.js";

export type Tier = "deep" | "brief" | "skip";

export interface NewsItem {
  id: string;
  title: string;
  summary: string;
  tier: Tier;
  relevance: number;
  reason: string;
  sources: { newsletter: string; subject: string }[];
  sourceCount: number;
  links: string[]; // original-article URLs, most relevant first (never read aloud)
}

const AnalysisSchema = z.object({
  items: z.array(
    z.object({
      title: z.string().describe("新知標題（繁體中文，專有名詞保留英文）"),
      summary: z
        .string()
        .describe("2～4 句繁體中文摘要，只寫電子報中有寫的事實；數字、版本號、日期照原文"),
      sources: z
        .array(
          z.object({
            newsletter_id: z.string().describe("來源電子報 id，例如 n1"),
            link_ref: z.string().describe('該則在此電子報中對應的原文連結標記，例如 "L3"；沒有則填空字串'),
          }),
        )
        .describe("提到這則新知的所有電子報；最主要的原文連結放第一個"),
      tier: z.enum(["deep", "brief", "skip"]),
      relevance: z.number().int().describe("0～100，與興趣的相關程度"),
      reason: z.string().describe("一句話說明為何給這個分級"),
    }),
  ),
});

function buildSystem(maxDeep: number) {
  return `你是電子報編輯，幫一位有經驗的前端工程師整理每天的技術新知與一般新聞。

任務：
1. 把每封電子報拆成一則一則的「新知項目」。一則新知是一個獨立事件、發布、文章或工具。電子報的開頭問候、目錄、編者閒聊、徵才、贊助廣告、活動促銷不算新知（若硬要列出，tier 給 skip）。
2. 去重：不同電子報報導同一件事時合併成一則，sources 列出所有提到它的電子報。同一電子報內重複出現的也合併。
3. 依 <interests> 中的興趣設定評分：
   - deep：屬於「高度感興趣」且內容有份量（重大發布、重要漏洞或事件、值得理解的新技術）
   - brief：屬於「一般感興趣」，或屬於高度感興趣但只是小更新
   - skip：不感興趣、廣告、促銷、活動報名，或不在興趣設定中的主題
   deep 最多 ${maxDeep} 則；多個來源都提到的新知可視為較重要。
4. relevance 為 0～100 的整數，deep 項目要給最高分，方便排序。

規則：
- summary 只能根據電子報內容撰寫，不要加入外部知識或推測。
- link_ref 只能填電子報文字中實際出現的 [L數字] 標記（去掉方括號），不要自己編造。
- 輸出必須涵蓋電子報中所有的新知，不要遺漏。

${UNTRUSTED_NOTICE}`;
}

function renderNewsletters(newsletters: Newsletter[]): string {
  return newsletters
    .map(
      (n) =>
        `<newsletter id="${n.id}" sender="${escapeAttr(n.sender)}" subject="${escapeAttr(n.subject)}" received="${n.receivedAt}">\n${escapeTag(n.text)}\n</newsletter>`,
    )
    .join("\n\n");
}

export async function analyze(
  client: Anthropic,
  config: Config,
  interests: string,
  newsletters: Newsletter[],
): Promise<NewsItem[]> {
  const out = await callStructured(client, {
    label: "拆解與評分",
    model: config.CLAUDE_MODEL,
    system: buildSystem(config.MAX_DEEP_ITEMS),
    user: `<interests>\n${interests}\n</interests>\n\n以下是今天的 ${newsletters.length} 封電子報（技術電子報與新聞）：\n\n${renderNewsletters(newsletters)}`,
    schema: AnalysisSchema,
    maxTokens: 64000,
  });

  const byId = new Map(newsletters.map((n) => [n.id, n]));
  const items: NewsItem[] = out.items.map((it, i) => {
    const sources = it.sources.filter((s) => byId.has(s.newsletter_id));
    const links: string[] = [];
    for (const s of sources) {
      const ref = s.link_ref.replace(/[[\]]/g, "").trim();
      const url = byId.get(s.newsletter_id)!.links.find((l) => l.ref === ref)?.url;
      if (url && !links.includes(url)) links.push(url);
    }
    const uniqueSources = [...new Set(sources.map((s) => s.newsletter_id))].map((id) => ({
      newsletter: byId.get(id)!.sender,
      subject: byId.get(id)!.subject,
    }));
    return {
      id: `i${i + 1}`,
      title: it.title,
      summary: it.summary,
      tier: it.tier,
      relevance: Math.max(0, Math.min(100, it.relevance)),
      reason: it.reason,
      sources: uniqueSources,
      sourceCount: uniqueSources.length,
      links,
    };
  });

  // Enforce the deep limit: keep the most relevant (ties → more sources), demote the rest.
  const deep = items
    .filter((i) => i.tier === "deep")
    .sort((a, b) => b.relevance - a.relevance || b.sourceCount - a.sourceCount);
  for (const extra of deep.slice(config.MAX_DEEP_ITEMS)) {
    extra.tier = "brief";
    extra.reason += `（超過 deep 上限 ${config.MAX_DEEP_ITEMS} 則，降為 brief）`;
  }

  const order: Record<Tier, number> = { deep: 0, brief: 1, skip: 2 };
  return items.sort((a, b) => order[a.tier] - order[b.tier] || b.relevance - a.relevance);
}
