// F6: upload the episode to the app-owned `mailcast` folder in Drive and prune old episodes.
// With the drive.file scope the app only sees files it created, so the folder is created here.
import { createReadStream } from "node:fs";
import path from "node:path";
import { google, type drive_v3 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { log, taipeiDate, withRetry } from "./util.js";

const FOLDER_NAME = "mailcast";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const EPISODE_RE = /^mailcast-(\d{4}-\d{2}-\d{2})\.mp3$/;

type Drive = drive_v3.Drive;

export function driveClient(auth: OAuth2Client) {
  return google.drive({ version: "v3", auth });
}

/** Escape a value for a Drive `q` string literal. */
const q = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

async function listAll(drive: Drive, query: string, fields = "id, name, createdTime") {
  const files: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;
  do {
    const res = await withRetry("Drive 列表", () =>
      drive.files.list({
        q: query,
        fields: `nextPageToken, files(${fields})`,
        spaces: "drive",
        pageSize: 100,
        orderBy: "createdTime",
        pageToken,
      }),
    );
    files.push(...(res.data.files ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return files;
}

/** Find the app-created `mailcast` folder in My Drive root, or create it. */
async function ensureFolder(drive: Drive): Promise<string> {
  const found = await listAll(
    drive,
    `name = ${q(FOLDER_NAME)} and mimeType = ${q(FOLDER_MIME)} and 'root' in parents and trashed = false`,
  );
  // Oldest first, so a stray duplicate folder never takes over.
  if (found[0]?.id) return found[0].id;
  const res = await withRetry("Drive 建立資料夾", () =>
    drive.files.create({
      requestBody: { name: FOLDER_NAME, mimeType: FOLDER_MIME, parents: ["root"] },
      fields: "id",
    }),
  );
  if (!res.data.id) throw new Error("Drive 建立 mailcast 資料夾失敗");
  log("Drive：建立 mailcast 資料夾");
  return res.data.id;
}

/** Oldest date (YYYY-MM-DD, Asia/Taipei) that is still kept: today and the previous days-1 days. */
export function retentionCutoff(today: string, days: number): string {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString().slice(0, 10);
}

export interface UploadResult {
  fileId: string;
  replaced: boolean;
  deleted: number;
}

/**
 * Upload (or overwrite) today's mp3 and delete episodes older than the retention window.
 * Re-running on the same day updates the existing file in place, so its id stays the same.
 */
export async function uploadEpisode(
  drive: Drive,
  file: string,
  retentionDays: number,
  today = taipeiDate(),
): Promise<UploadResult> {
  const name = path.basename(file);
  const folderId = await ensureFolder(drive);
  const media = () => ({ mimeType: "audio/mpeg", body: createReadStream(file) });

  const existing = await listAll(drive, `name = ${q(name)} and ${q(folderId)} in parents and trashed = false`);
  let fileId: string;
  if (existing[0]?.id) {
    const id = existing[0].id;
    await withRetry("Drive 覆蓋檔案", () => drive.files.update({ fileId: id, media: media(), fields: "id" }));
    fileId = id;
    // Clean up duplicates left by an earlier failed run.
    for (const dup of existing.slice(1)) {
      if (dup.id) await withRetry("Drive 刪除重複檔", () => drive.files.delete({ fileId: dup.id! }));
    }
  } else {
    const res = await withRetry("Drive 上傳", () =>
      drive.files.create({ requestBody: { name, parents: [folderId] }, media: media(), fields: "id" }),
    );
    if (!res.data.id) throw new Error("Drive 上傳失敗：沒有回傳檔案 id");
    fileId = res.data.id;
  }

  // Retention: only touch files named mailcast-YYYY-MM-DD.mp3.
  const cutoff = retentionCutoff(today, retentionDays);
  const all = await listAll(drive, `${q(folderId)} in parents and trashed = false`);
  let deleted = 0;
  for (const f of all) {
    const date = f.name?.match(EPISODE_RE)?.[1];
    if (!f.id || !date || date >= cutoff) continue;
    await withRetry("Drive 刪除舊檔", () => drive.files.delete({ fileId: f.id! }));
    deleted++;
  }

  return { fileId, replaced: existing.length > 0, deleted };
}
