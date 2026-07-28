#!/usr/bin/env node
// Telegram bot that generates Google Flow images from your phone.
// Dependency-free (uses Node 18+ global fetch / FormData / Blob).
//
// Config (in config/flow.config.json):
//   "telegramBotToken":     "<from @BotFather>"
//   "telegramAllowedChatId": 123456789   (your numeric Telegram id; optional but recommended)
//
// Run: node scripts/telegram-bot.mjs
import fs from 'fs';
import { get } from '../src/utils/config.js';
import { launchChromeDirect, closeBrowser } from '../src/browser/connect.js';
import { navigateToFlow } from '../src/browser/launch-profile.js';
import { handleGenerateImage } from '../src/tools/generate-image.js';

const TOKEN = get('telegramBotToken');
const ALLOWED = get('telegramAllowedChatId');
const API = `https://api.telegram.org/bot${TOKEN}`;

if (!TOKEN) {
  console.error('[bot] Missing "telegramBotToken" in config/flow.config.json. Get one from @BotFather.');
  process.exit(1);
}

let busy = false;

async function tg(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sendMessage(chatId, text) {
  return tg('sendMessage', { chat_id: chatId, text });
}

async function sendPhoto(chatId, filePath, caption) {
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  if (caption) fd.append('caption', caption);
  const buf = fs.readFileSync(filePath);
  fd.append('photo', new Blob([buf]), filePath.split('/').pop());
  const res = await fetch(`${API}/sendPhoto`, { method: 'POST', body: fd });
  return res.json();
}

function isAllowed(chatId) {
  if (ALLOWED === undefined || ALLOWED === null || ALLOWED === '') return true;
  return String(chatId) === String(ALLOWED);
}

async function generate(chatId, prompt) {
  if (busy) {
    await sendMessage(chatId, '⏳ Hozir boshqa rasm yasalyapti. Biroz kuting va qayta yuboring.');
    return;
  }
  busy = true;
  try {
    await sendMessage(chatId, `🎨 Yasayapman: "${prompt}"\nBu 30-90 soniya olishi mumkin...`);
    const { page } = await launchChromeDirect({ headless: true });
    await navigateToFlow(page);
    const genPromise = handleGenerateImage({
      prompt,
      model: 'Nano Banana 2',
      ratio: '1:1',
      auto_confirm: true,
      project_name: 'Telegram',
      campaign: 'telegram',
    });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Generatsiya juda uzoq davom etdi (timeout).')), 180000)
    );
    const result = await Promise.race([genPromise, timeoutPromise]);
    if (result.files && result.files.length) {
      for (const f of result.files) {
        await sendPhoto(chatId, f, `✅ ${prompt}`);
      }
    } else {
      await sendMessage(chatId, '⚠️ Rasm yasaldi, lekin fayl topilmadi.');
    }
  } catch (e) {
    await sendMessage(chatId, `❌ Xato: ${e.message}`);
  } finally {
    try { await closeBrowser(); } catch {}
    busy = false;
  }
}

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (!isAllowed(chatId)) {
    await sendMessage(chatId, `Ruxsat yo'q. Sizning chat ID: ${chatId}`);
    return;
  }

  if (text === '/start' || text === '/help') {
    await sendMessage(chatId,
      '👋 Salom! Rasm yasash uchun oddiy matn (prompt) yuboring.\n' +
      'Masalan: "a cute robot holding a banana, neon lighting"\n\n' +
      `Sizning chat ID: ${chatId}`);
    return;
  }

  if (text.startsWith('/')) {
    await sendMessage(chatId, 'Prompt yuboring (rasm tavsifini yozing).');
    return;
  }

  await generate(chatId, text);
}

async function main() {
  console.log('[bot] Starting. Allowed chat:', ALLOWED ?? '(anyone)');
  // Clear any pending webhook so long polling works.
  await fetch(`${API}/deleteWebhook`).catch(() => {});
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetch(`${API}/getUpdates?timeout=30&offset=${offset}`);
      const data = await res.json();
      if (data.ok && data.result.length) {
        for (const upd of data.result) {
          offset = upd.update_id + 1;
          handleUpdate(upd).catch((e) => console.error('[bot] handler error:', e.message));
        }
      }
    } catch (e) {
      console.error('[bot] poll error:', e.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

main();
