# mailcast

每天把 Gmail 裡的技術電子報整理成一集中文 Podcast。需求見 [SPEC.md](SPEC.md)。

> 目前進度：Phase 3（上傳 Drive + GitHub Actions 排程）。完整設定教學在 Phase 4。

## 快速開始

需求：Node.js 24 以上（`nvm use` 會讀 `.nvmrc`）。

```bash
nvm use
npm install
cp .env.example .env   # 填入 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / ANTHROPIC_API_KEY
npm run auth           # 瀏覽器登入 Google，把印出的 GOOGLE_REFRESH_TOKEN 填進 .env
npm run start -- --script-only   # 只產生評分結果與廣播稿
npm run start -- --dry-run       # 再加上 mp3（需要 GOOGLE_TTS_CREDENTIALS）
npm run start                    # 完整流程：再上傳到 Google Drive 的 mailcast 資料夾
```

OAuth 用戶端請在 Google Cloud Console 建立「桌面應用程式」類型，並啟用 Gmail API。`npm run auth` 只申請 `gmail.readonly` 與 `drive.file` 兩個權限。

### 語音（Phase 2）：產生 `GOOGLE_TTS_CREDENTIALS`

TTS 用「服務帳戶」認證，跟 Gmail 用的 OAuth 是分開的。服務帳戶是給程式用的機器帳號，金鑰是一份 JSON 檔。

**1. 確認專案與帳單**

1. 打開 [Google Cloud Console](https://console.cloud.google.com/)，在左上角的專案選單選擇跟 Gmail OAuth 同一個專案
2. Text-to-Speech 需要專案有綁定帳單帳戶：左側選單「帳單（Billing）」→ 若顯示沒有帳單帳戶，依指示連結一個
   - 每月有免費額度（WaveNet 語音約 100 萬字元），每天一集約 3,000 字，一個月約 9 萬字，通常不會產生費用
   - 建議在「帳單 → 預算與快訊」設一個小額預算提醒，以防萬一

**2. 啟用 API**

1. 左側選單「API 和服務」→「程式庫」
2. 搜尋 `Cloud Text-to-Speech API` → 點進去 → 按「啟用」

**3. 建立服務帳戶**

1. 左側選單「IAM 與管理」→「服務帳戶」→ 上方「建立服務帳戶」
2. 服務帳戶名稱填 `mailcast-tts`（ID 會自動產生），說明可留空 → 按「建立並繼續」
3. 「授予這個服務帳戶專案存取權」：**不用選任何角色**，直接按「繼續」
4. 「授予使用者存取這個服務帳戶的權限」：留空，按「完成」

**4. 建立 JSON 金鑰**

1. 在服務帳戶清單點剛建立的 `mailcast-tts@<專案ID>.iam.gserviceaccount.com`
2. 切到「金鑰」頁籤 →「新增金鑰」→「建立新的金鑰」
3. 金鑰類型選「JSON」→「建立」，瀏覽器會下載一個像 `<專案ID>-xxxxxxxxxxxx.json` 的檔案
   - 這份檔案等同密碼，而且只能下載這一次；遺失的話刪掉重建一把即可
   - 若出現「已停用服務帳戶金鑰建立功能」（`iam.disableServiceAccountKeyCreation`），代表專案屬於某個機構且機構政策禁止建立金鑰。個人 Gmail 建立的專案通常不會遇到；遇到的話請改用個人帳號建立的專案

**5. 填進 `.env`**

建議轉成 base64（單行、沒有特殊字元，之後也可以原封不動貼進 GitHub Secrets）。在終端機執行（路徑換成實際下載的檔名）：

```bash
base64 -i ~/Downloads/<專案ID>-xxxxxxxxxxxx.json | tr -d '\n' | pbcopy
```

這會把結果直接複製到剪貼簿、不會顯示在畫面上。打開 `.env`，貼在 `GOOGLE_TTS_CREDENTIALS=` 後面（同一行，不要加引號）。

**6. 驗證**

```bash
npm run voices
```

成功時會列出 `cmn-TW-...` 開頭的語音清單。常見錯誤：

| 錯誤訊息 | 原因 |
|---|---|
| `GOOGLE_TTS_CREDENTIALS 不是有效的 JSON` | 貼的內容不完整，或換行沒去掉，重做第 5 步 |
| `Cloud Text-to-Speech API has not been used in project ...` | 第 2 步的 API 沒啟用，或啟用到別的專案 |
| `This API method requires billing to be enabled` | 第 1 步的帳單帳戶沒綁定 |
| `invalid_grant` / `Invalid JWT Signature` | 金鑰已被刪除或停用，重新建立一把 |

**7. 收尾**

- 驗證成功後，把下載的 JSON 檔刪除（或移到密碼管理器），**不要放進 repo 資料夾**
- Phase 3 設定 GitHub Secrets 時，`GOOGLE_TTS_CREDENTIALS` 填同一串 base64 即可
- 金鑰外洩時：回到服務帳戶的「金鑰」頁籤刪除該金鑰，再建一把新的

**挑選語音**：預設使用 Gemini-TTS（`TTS_MODEL=gemini-2.5-flash-tts`、`TTS_VOICE=Kore`），聽起來比舊的 WaveNet 自然很多，語氣與語速由 `TTS_STYLE_PROMPT` 的自然語言指示控制。

- `npm run voices -- --sample` 會用同一段示範稿，以幾個 Gemini 語音和 `cmn-TW-Wavenet-A` 各產生一個試聽檔到 `output/voice-samples/`，挑喜歡的填進 `TTS_VOICE`
- Gemini-TTS 的 `cmn-TW` 目前是 Preview，日後可能變動；費用依音訊長度計，比 WaveNet 高，每天一集約十分鐘大約是每月數美元等級，實際以 [官方價目表](https://cloud.google.com/text-to-speech/pricing) 為準
- 沿用同一個服務帳戶，但專案要**另外啟用 Vertex AI API**（`aiplatform.googleapis.com`，主控台可能顯示為「Agent Platform API」）：「API 和服務」→「程式庫」搜尋後按「啟用」，等幾分鐘生效。沒啟用時試聽會出現 `Agent Platform API has not been used in project ...`
- 想切回舊語音：設定 `TTS_MODEL=none`、`TTS_VOICE=cmn-TW-Wavenet-A`，此時語速與音調用 `TTS_SPEAKING_RATE`、`TTS_PITCH` 調整

音檔使用 [ffmpeg-static](https://www.npmjs.com/package/ffmpeg-static) 內附的 ffmpeg 編碼，不需要另外安裝。

## 上傳與排程（Phase 3）

### Google Drive

1. Google Cloud Console →「API 和服務」→「程式庫」搜尋 `Google Drive API` → 按「啟用」（跟 Gmail 同一個專案）
2. 不需要重新執行 `npm run auth`：refresh token 當初已經包含 `drive.file` 權限
3. `npm run start` 會在 Drive 根目錄建立 `mailcast` 資料夾並上傳當天的 `mailcast-YYYY-MM-DD.mp3`
   - 因為 `drive.file` 只能看到程式自己建立的檔案，請不要手動建立同名資料夾；程式看不到它，會另建一個
   - 同一天重複執行會覆蓋同一個檔案（檔案 id 不變），不會產生重複檔
   - 上傳後刪除資料夾中超過 `RETENTION_DAYS`（預設 7）天的 `mailcast-*.mp3`，只會動這種檔名的檔案

### GitHub Actions（`.github/workflows/mailcast.yml`）

- 每天 UTC 22:00（台灣時間 06:00）執行完整流程；GitHub 的排程常會延遲幾分鐘到半小時以上
- 「Actions」→「mailcast」→「Run workflow」可手動觸發，並選擇模式 `full` / `dry-run` / `script-only`
  - `dry-run`、`script-only` 會把當天的 `output/` 存成 artifact `output-<模式>`（保留 3 天）方便檢查；排程執行不會保存這些內容
- 「Settings」→「Secrets and variables」→「Actions」→「Secrets」新增：
  `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_REFRESH_TOKEN`、`GOOGLE_TTS_CREDENTIALS`、`ANTHROPIC_API_KEY`（內容跟 `.env` 相同）
- 其他設定（`CLAUDE_MODEL`、`GMAIL_QUERY`、`TTS_VOICE`、`RETENTION_DAYS` 等）可以在同一頁的「Variables」新增同名變數覆蓋預設值，不設就用預設
- `newsletter-senders.json` 每次執行後存成 artifact `newsletter-senders`（保留 90 天），下次執行會自動接續累計；要下載時到任一次執行的頁面最下方「Artifacts」

### 錯誤處理

- 任一必要步驟失敗（Gmail、分類、評分、寫稿、TTS、上傳）程式會以非零狀態碼結束，workflow 會標示失敗，GitHub 預設會寄信通知
- 原文抓取（F3）失敗不算錯誤，會改用電子報摘要
- Google API 遇到 429 / 5xx / 網路錯誤會重試 3 次（1、2、4 秒）；Claude SDK 也會自動重試 3 次
- 日誌只有流程狀態與數量，沒有郵件內文、廣播稿或金鑰

### 驗證

1. 本機 `npm run start`，確認 Drive 出現 `mailcast/mailcast-YYYY-MM-DD.mp3`；再跑一次，確認仍然只有一個檔案
2. 設好 Secrets 後手動觸發 workflow（模式 `full`），確認成功且 Drive 檔案更新
3. 故意把 Secret `ANTHROPIC_API_KEY` 改成錯的值再手動觸發，確認 workflow 顯示失敗；驗證完改回來

## 輸出（`output/`，不會進 git）

| 檔案 | 內容 |
|---|---|
| `YYYY-MM-DD/classification.json` | 每封候選信的分類與理由，用來檢查誤判 |
| `YYYY-MM-DD/newsletters.json` | 技術電子報與新聞轉成的純文字與連結 |
| `YYYY-MM-DD/analysis.json` | 拆解、去重、評分後的新知（deep / brief / skip） |
| `YYYY-MM-DD/articles.json` | deep 項目的原文抓取結果 |
| `YYYY-MM-DD/script.txt` | 廣播稿（`script.json` 為分段版本，用來在段落間插入停頓） |
| `YYYY-MM-DD/mailcast-YYYY-MM-DD.mp3` | 音檔（`--dry-run` 或完整流程） |
| `newsletter-senders.json` | 累計的技術電子報與新聞寄件者名單 |

## 調整內容

- 興趣：編輯 `interests.md`
- 評分 prompt：`src/analyze.ts` 的 `buildSystem`
- 廣播稿 prompt：`src/script.ts` 的 `buildSystem`
- 改用 Gmail 標籤模式：把 `GMAIL_QUERY` 設成例如 `is:unread newer_than:1d label:newsletter`，查詢含 `label:` 時會自動跳過分類（可用 `SKIP_CLASSIFY=true/false` 強制指定）
