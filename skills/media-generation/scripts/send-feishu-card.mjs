#!/usr/bin/env node
/**
 * Standalone Feishu card sender — no external dependencies.
 * Reads Feishu credentials from ~/.openclaw/openclaw.json.
 *
 * Usage:
 *   node send-feishu-card.mjs <card-file.json> --chat-id oc_xxx
 *   node send-feishu-card.mjs --json '<card-json>' --chat-id oc_xxx
 *   node send-feishu-card.mjs <card-file.json> --open-id ou_xxx
 *   node send-feishu-card.mjs --json '<card-json>' --update <message_id>
 *
 * Outputs: "message_id:<id>" on success (parseable by agent for streaming updates)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

// --- Parse args ---
const args = process.argv.slice(2);
let cardFile = null;
let cardJsonStr = null;
let chatId = null;
let openId = null;
let updateMessageId = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--chat-id' || arg === '--open-id' || arg === '--json' || arg === '--update') {
    const val = args[i + 1];
    if (!val || val.startsWith('--')) {
      console.error(`Error: ${arg} requires a value`);
      process.exitCode = 1;
      process.exit();
    }
    i++;
    if (arg === '--chat-id')  chatId          = val;
    if (arg === '--open-id')  openId          = val;
    if (arg === '--json')     cardJsonStr     = val;
    if (arg === '--update')   updateMessageId = val;
  } else if (!arg.startsWith('--')) {
    cardFile = arg;
  }
}

// In update mode, --chat-id / --open-id are not required
if (!updateMessageId) {
  if (chatId && openId) {
    console.error('Error: provide --chat-id or --open-id, not both');
    process.exitCode = 1;
    process.exit();
  }
  if (!chatId && !openId) {
    console.error('Error: --chat-id or --open-id is required (or use --update <message_id>)');
    process.exitCode = 1;
    process.exit();
  }
}

if (!cardFile && !cardJsonStr) {
  console.error('Error: provide a card file path or --json <json-string>');
  process.exitCode = 1;
  process.exit();
}

const receiveId     = chatId ?? openId;
const receiveIdType = openId ? 'open_id' : 'chat_id';

// --- Load card ---
let card;
try {
  if (cardJsonStr) {
    card = JSON.parse(cardJsonStr);
  } else {
    const expanded = cardFile.startsWith('~/')
      ? path.join(os.homedir(), cardFile.slice(2))
      : cardFile;
    const p = path.isAbsolute(expanded) ? expanded : path.resolve(process.cwd(), expanded);
    card = JSON.parse(fs.readFileSync(p, 'utf-8'));
  }
} catch (e) {
  console.error('Error loading card:', e.message);
  process.exitCode = 1;
  process.exit();
}

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

// --- Feishu API calls ---
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

async function sendCard(token) {
  const res = await fetch(
    `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ receive_id: receiveId, msg_type: 'interactive', content: JSON.stringify(card) }),
    },
  );
  if (!res.ok) throw new Error(`Send HTTP ${res.status}: ${res.statusText}`);
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Send failed: ${data.msg} (code: ${data.code})`);
  const messageId = data.data?.message_id;
  console.log(`✅ Card sent (message_id: ${messageId})`);
  console.log(`message_id:${messageId}`);
}

async function updateCard(token) {
  const res = await fetch(
    `https://open.feishu.cn/open-apis/im/v1/messages/${updateMessageId}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: JSON.stringify(card) }),
    },
  );
  if (!res.ok) throw new Error(`Update HTTP ${res.status}: ${res.statusText}`);
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Update failed: ${data.msg} (code: ${data.code})`);
  console.log(`✅ Card updated (message_id: ${updateMessageId})`);
}

(async () => {
  const token = await getTenantAccessToken();
  if (updateMessageId) {
    await updateCard(token);
  } else {
    await sendCard(token);
  }
})().catch(e => {
  console.error('❌', e.message);
  process.exitCode = 1;
});
