// Entry point: `npm run start [-- --dry-run | --script-only]`
import { readFile } from "node:fs/promises";
import { analyze, type NewsItem } from "./analyze.js";
import { claudeClient } from "./claude.js";
import { classify, updateSenderList } from "./classify.js";
import { loadConfig, ttsCredentials } from "./config.js";
import { fetchArticles, type ArticleResult } from "./fetchArticle.js";
import { fetchNewsletter, gmailClient, listCandidates, type Newsletter } from "./gmail.js";
import { googleAuth } from "./google.js";
import { emptyScript, scriptToText, writeScript, type Script } from "./script.js";
import { formatDuration, synthesize } from "./tts.js";
import { log, taipeiDate, taipeiDateLong, writeOutput } from "./util.js";

function parseArgs(argv: string[]) {
  const known = new Set(["--dry-run", "--script-only"]);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length) throw new Error(`未知的參數：${unknown.join(" ")}`);
  return { dryRun: argv.includes("--dry-run"), scriptOnly: argv.includes("--script-only") };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const date = taipeiDate();
  const dateLong = taipeiDateLong();
  const outDir = date;
  log(`mailcast ${date} 開始（${args.scriptOnly ? "script-only" : args.dryRun ? "dry-run" : "完整流程"}）`);

  // Fail fast on a missing/invalid TTS key before spending on Gmail/Claude calls.
  if (!args.scriptOnly) ttsCredentials(config);

  const gmail = gmailClient(googleAuth(config));
  const claude = claudeClient(config);
  const interests = await readFile("interests.md", "utf8");

  // F1-1
  const candidates = await listCandidates(gmail, config.GMAIL_QUERY, config.MAX_CANDIDATES);
  log(`候選信件 ${candidates.length} 封`);

  // F1-2
  const classified = await classify(claude, config, candidates);
  await writeOutput(`${outDir}/classification.json`, classified);
  const count = (c: string) => classified.filter((m) => m.category === c).length;
  const bulkCount = candidates.filter((c) => c.hasListUnsubscribe || c.hasListId).length;
  log(
    config.skipClassify
      ? `標籤模式：略過分類，全部 ${candidates.length} 封視為電子報`
      : `大量寄送 ${bulkCount} 封 → 技術電子報 ${count("tech_newsletter")} / 其他大量寄送 ${count("other_bulk")} / 個人 ${count("personal")}；一般信件 ${count("not_bulk")}`,
  );
  // "一般未讀信" = mail a person would read: non-bulk + personal. Unknown in label mode.
  const generalMailCount = config.skipClassify ? null : count("not_bulk") + count("personal");

  // F1-4
  const senderTotal = await updateSenderList(classified);
  log(`電子報寄件者名單累計 ${senderTotal} 個`);

  // F1-3
  const techMails = classified.filter((m) => m.category === "tech_newsletter").slice(0, config.MAX_EMAILS);
  const newsletters: Newsletter[] = [];
  for (const [i, m] of techMails.entries()) newsletters.push(await fetchNewsletter(gmail, m, `n${i + 1}`));
  await writeOutput(`${outDir}/newsletters.json`, newsletters);
  log(`抓取電子報內文 ${newsletters.length} 封（截斷 ${newsletters.filter((n) => n.truncated).length} 封）`);

  let items: NewsItem[] = [];
  let articles: ArticleResult[] = [];
  let script: Script;

  if (newsletters.length === 0) {
    log("今天沒有技術電子報，產生簡短稿");
    script = emptyScript(dateLong, generalMailCount);
  } else {
    // F2
    items = await analyze(claude, config, interests, newsletters);
    await writeOutput(`${outDir}/analysis.json`, items);
    const tier = (t: string) => items.filter((i) => i.tier === t).length;
    log(`新知 ${items.length} 則：deep ${tier("deep")} / brief ${tier("brief")} / skip ${tier("skip")}`);

    // F3 (non-fatal)
    articles = await fetchArticles(items.filter((i) => i.tier === "deep"));
    await writeOutput(`${outDir}/articles.json`, articles);
    log(`原文抓取：成功 ${articles.filter((a) => a.ok).length} / 失敗 ${articles.filter((a) => !a.ok).length}`);

    // F4
    script = await writeScript(claude, config, {
      dateLong,
      newsletterCount: newsletters.length,
      generalMailCount,
      items,
      articles,
    });
  }

  await writeOutput(`${outDir}/script.json`, script);
  const scriptFile = await writeOutput(`${outDir}/script.txt`, scriptToText(script));
  log(
    `廣播稿 ${script.chars.toLocaleString("en-US")} 字，${script.sections.length} 段` +
      (script.sanitized ? `（清除了 ${script.sanitized} 處不適合朗讀的符號）` : ""),
  );
  log(`輸出：${scriptFile}`);

  if (args.scriptOnly) return;

  // F5
  const audio = await synthesize(config, script, date);
  log(`音檔 ${formatDuration(audio.seconds)}（TTS ${audio.chunks} 段）：${audio.file}`);

  if (args.dryRun) return;

  // F6 is implemented in Phase 3.
  throw new Error("上傳 Drive（Phase 3）尚未實作，目前請使用 --dry-run 或 --script-only");
}

main().catch((err) => {
  // Error messages only; no mail content is included in thrown errors.
  console.error(`mailcast 失敗：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
