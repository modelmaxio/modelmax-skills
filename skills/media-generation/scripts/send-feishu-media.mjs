#!/usr/bin/env node
/**
 * Standalone Feishu media sender — no external dependencies.
 * Images are uploaded via /im/v1/images and sent as msg_type:"image" (renders inline).
 * Videos are uploaded via /im/v1/files as video files and sent as msg_type:"media" with a cover image.
 * Other files are uploaded via /im/v1/files and sent as msg_type:"file".
 * Reads Feishu credentials from ~/.openclaw/openclaw.json.
 *
 * Usage:
 *   node send-feishu-media.mjs <file-path> --chat-id oc_xxx
 *   node send-feishu-media.mjs <file-path> --open-id ou_xxx
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

// --- Parse args ---
const args = process.argv.slice(2);
let filePath = null;
let chatId = null;
let openId = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--chat-id' || arg === '--open-id') {
    const val = args[i + 1];
    if (!val || val.startsWith('--')) {
      console.error(`Error: ${arg} requires a value`);
      process.exitCode = 1;
      process.exit();
    }
    i++;
    if (arg === '--chat-id') chatId = val;
    if (arg === '--open-id') openId = val;
  } else if (!arg.startsWith('--')) {
    filePath = arg;
  }
}

if (chatId && openId) {
  console.error('Error: provide --chat-id or --open-id, not both');
  process.exitCode = 1;
  process.exit();
}

const receiveId = chatId ?? openId;
const receiveIdType = openId ? 'open_id' : 'chat_id';

if (!receiveId) {
  console.error('Error: --chat-id or --open-id is required');
  process.exitCode = 1;
  process.exit();
}
if (!filePath) {
  console.error('Error: provide a file path');
  process.exitCode = 1;
  process.exit();
}

const expanded = filePath.startsWith('~/')
  ? path.join(os.homedir(), filePath.slice(2))
  : filePath;
const absoluteFilePath = path.isAbsolute(expanded) ? expanded : path.resolve(process.cwd(), expanded);

if (!fs.existsSync(absoluteFilePath)) {
  console.error(`Error: File not found: ${absoluteFilePath}`);
  process.exitCode = 1;
  process.exit();
}

const ext = path.extname(absoluteFilePath).toLowerCase().slice(1);
const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const videoExts = ['mp4', 'mov', 'avi'];
const isImage = imageExts.includes(ext);
const isVideo = videoExts.includes(ext);

// --- Load OpenClaw config ---
const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
} catch (e) {
  console.error('Error reading openclaw.json:', e.message);
  process.exitCode = 1;
  process.exit();
}

const accounts = config?.channels?.feishu?.accounts;
if (!accounts) {
  console.error('Error: No feishu accounts found in ~/.openclaw/openclaw.json');
  process.exitCode = 1;
  process.exit();
}
const account = accounts.main ?? Object.values(accounts)[0];
if (!account?.appId || !account?.appSecret) {
  console.error('Error: Feishu account is missing appId or appSecret');
  process.exitCode = 1;
  process.exit();
}

async function getTenantAccessToken() {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: account.appId, app_secret: account.appSecret }),
  });
  if (!res.ok) throw new Error(`Auth HTTP ${res.status}: ${res.statusText}`);
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Auth failed: ${data.msg}`);
  return data.tenant_access_token;
}

function inferImageMimeType(sourcePath) {
  const sourceExt = path.extname(sourcePath).toLowerCase().slice(1);
  const mimeTypes = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
  };
  return mimeTypes[sourceExt] || 'image/jpeg';
}

async function uploadImageFile(token, sourcePath) {
  const fileBuffer = fs.readFileSync(sourcePath);
  const fileName = path.basename(sourcePath);

  const formData = new FormData();
  formData.append('image_type', 'message');
  formData.append('image', new Blob([fileBuffer], { type: inferImageMimeType(sourcePath) }), fileName);

  const res = await fetch('https://open.feishu.cn/open-apis/im/v1/images', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  if (!res.ok) throw new Error(`Image upload HTTP ${res.status}: ${res.statusText}`);
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Image upload failed: ${data.msg} (code: ${data.code})`);
  return data.data.image_key;
}

function probeVideoDurationSeconds(sourcePath) {
  const raw = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=nokey=1:noprint_wrappers=1',
      sourcePath,
    ],
    { encoding: 'utf8' },
  ).trim();
  const seconds = Math.max(1, Math.round(Number(raw)));
  if (!Number.isFinite(seconds)) {
    throw new Error(`Unable to determine video duration for ${sourcePath}`);
  }
  return seconds;
}

function extractVideoCoverImage(sourcePath) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-video-cover-'));
  const coverPath = path.join(tempDir, `${path.basename(sourcePath, path.extname(sourcePath))}.jpg`);
  try {
    execFileSync(
      'ffmpeg',
      ['-y', '-i', sourcePath, '-frames:v', '1', '-q:v', '2', coverPath],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    if (!fs.existsSync(coverPath)) {
      throw new Error(`Cover image was not created for ${sourcePath}`);
    }
    return {
      coverPath,
      cleanup() {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      },
    };
  } catch (error) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    throw error;
  }
}

async function uploadFile(token, sourcePath, options = {}) {
  const fileBuffer = fs.readFileSync(sourcePath);
  const fileName = path.basename(sourcePath);
  const sourceExt = path.extname(sourcePath).toLowerCase().slice(1);
  const fileTypes = { mp4: 'mp4', mov: 'mov', avi: 'avi', pdf: 'pdf', doc: 'doc', xls: 'xls', ppt: 'ppt' };
  const fileType = fileTypes[sourceExt] || 'stream';

  const formData = new FormData();
  formData.append('file_type', fileType);
  formData.append('file_name', fileName);
  if (typeof options.durationSeconds === 'number' && Number.isFinite(options.durationSeconds) && options.durationSeconds > 0) {
    formData.append('duration', String(options.durationSeconds));
  }
  formData.append('file', new Blob([fileBuffer]), fileName);

  const res = await fetch('https://open.feishu.cn/open-apis/im/v1/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  if (!res.ok) throw new Error(`File upload HTTP ${res.status}: ${res.statusText}`);
  const data = await res.json();
  if (data.code !== 0) throw new Error(`File upload failed: ${data.msg} (code: ${data.code})`);
  return data.data.file_key;
}

async function sendMessage(token, msgType, content) {
  const res = await fetch(
    `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: msgType,
        content: JSON.stringify(content),
      }),
    },
  );
  if (!res.ok) throw new Error(`Send HTTP ${res.status}: ${res.statusText}`);
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Send failed: ${data.msg} (code: ${data.code})`);
  console.log(`✅ Media sent (message_id: ${data.data?.message_id})`);
}

(async () => {
  const token = await getTenantAccessToken();
  if (isImage) {
    const imageKey = await uploadImageFile(token, absoluteFilePath);
    await sendMessage(token, 'image', { image_key: imageKey });
  } else if (isVideo) {
    const durationSeconds = probeVideoDurationSeconds(absoluteFilePath);
    const cover = extractVideoCoverImage(absoluteFilePath);
    try {
      const imageKey = await uploadImageFile(token, cover.coverPath);
      const fileKey = await uploadFile(token, absoluteFilePath, { durationSeconds });
      await sendMessage(token, 'media', { file_key: fileKey, image_key: imageKey });
    } finally {
      cover.cleanup();
    }
  } else {
    const fileKey = await uploadFile(token, absoluteFilePath);
    await sendMessage(token, 'file', { file_key: fileKey });
  }
})().catch(e => {
  console.error('❌', e.message);
  process.exitCode = 1;
});
