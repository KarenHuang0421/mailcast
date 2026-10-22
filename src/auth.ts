// One-time OAuth flow: `npm run auth`
// Opens a browser, receives the code on a loopback port, prints the refresh token.
import "dotenv/config";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { google } from "googleapis";
import { GOOGLE_SCOPES, loadAuthConfig } from "./config.js";

function openBrowser(url: string) {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // The URL is printed below; the user can open it manually.
  }
}

async function main() {
  const { clientId, clientSecret } = loadAuthConfig();
  const state = randomBytes(16).toString("hex");

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${port}`;

  const oauth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const authUrl = oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // always return a refresh token
    scope: GOOGLE_SCOPES,
    state,
  });
  console.log(`\n正在開啟瀏覽器進行 Google 授權。若沒有自動開啟，請手動前往：\n\n${authUrl}\n`);
  openBrowser(authUrl);

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待授權逾時（5 分鐘）")), 5 * 60_000);
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      const err = url.searchParams.get("error");
      const got = url.searchParams.get("code");
      if (url.pathname !== "/" || (!got && !err)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (err || url.searchParams.get("state") !== state) {
        res.end("<p>授權失敗，請回到終端機查看。</p>");
        clearTimeout(timer);
        reject(new Error(`授權失敗：${err ?? "state 不符"}`));
        return;
      }
      res.end("<p>授權完成，可以關閉這個分頁並回到終端機。</p>");
      clearTimeout(timer);
      resolve(got!);
    });
  });
  server.close();

  const { tokens } = await oauth.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "沒有取得 refresh token。請到 https://myaccount.google.com/permissions 移除 mailcast 的存取權後重試。",
    );
  }
  const granted = (tokens.scope ?? "").split(" ").filter(Boolean);
  const missing = GOOGLE_SCOPES.filter((s) => !granted.includes(s));

  console.log("\n授權成功。請把下面這行存進 .env 與 GitHub Secrets（不要提交到 repo）：\n");
  console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  if (missing.length) {
    console.warn(`注意：以下權限沒有被授予，相關功能會失敗：${missing.join(", ")}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
