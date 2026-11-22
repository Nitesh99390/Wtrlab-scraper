import crypto from 'crypto';
import { config } from './config';
import { log, errMsg } from './logger';
import * as tg from './telegram';
import { escapeXml, extractWtrlabNovelRef } from './util';
import { HELP_TEXT, MAIN_MENU_KEYBOARD, START_TEXT, WTR_MENU_BUTTON } from './ui';
import { getPrefs, setPrefs } from './prefs';
import { getNovelByToken } from './registry';
import { cancelChatJobs, enqueueJob, jobStats, jobsForChat } from './jobs';
import type { ScrapeJob, ServiceMode } from './types';
import type { WtrlabCore } from './generated/wtrlab_core';

const PENDING_TTL_MS = 10 * 60 * 1000;
const pendingCustom = new Map<string, { token: string; total: number; expires: number }>();

let core: WtrlabCore;
export function initBot(c: WtrlabCore): void {
  core = c;
}

export const BOT_COMMANDS = [
  { command: 'start', description: 'Start the bot' },
  { command: 'help', description: 'Show help' },
  { command: 'wtr', description: 'WTR-Lab trending / search / novel link' },
  { command: 'wtrlab', description: 'Alias of /wtr' },
  { command: 'format', description: 'Choose output format (epub / txt)' },
  { command: 'status', description: 'Your running downloads' },
  { command: 'cancel', description: 'Cancel your downloads' },
];

const allowed = (chatId: string) => config.allowedChatIds.size === 0 || config.allowedChatIds.has(chatId);

function hostFor(chatId: string) {
  return core.createHost(getPrefs(chatId));
}

export async function handleUpdate(update: any): Promise<void> {
  try {
    if (update?.message) await onMessage(update.message);
    else if (update?.callback_query) await onCallback(update.callback_query);
  } catch (e) {
    log.error(`[bot] update ${update?.update_id} failed: ${errMsg(e)}`);
    const chatId = update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id;
    if (chatId) await tg.sendMessage(String(chatId), '⚠️ Kuch gadbad ho gayi. Kripya dobara try karein.').catch(() => {});
  }
}

async function onMessage(msg: any): Promise<void> {
  const chatId = String(msg?.chat?.id ?? '');
  const raw = typeof msg?.text === 'string' ? msg.text.trim() : '';
  if (!chatId || !raw) return;
  const isPrivate = msg.chat.type === 'private';

  if (!allowed(chatId)) {
    if (isPrivate) await tg.sendMessage(chatId, '🔒 Ye bot private hai. Aapko access nahi hai.');
    return;
  }

  // Normalise "/cmd@BotName args" -> "/cmd args"
  const first = raw.split(/\s+/)[0];
  const commandWord = first.toLowerCase().replace(/@[a-z0-9_]+$/i, '');
  const rest = raw.slice(first.length).trim();
  const text = raw.startsWith('/') ? `${commandWord}${rest ? ' ' + rest : ''}` : raw;
  const lowerText = text.toLowerCase();

  if (raw.startsWith('/')) pendingCustom.delete(chatId);

  switch (commandWord) {
    case '/start':
      await tg.sendMessage(chatId, START_TEXT, MAIN_MENU_KEYBOARD);
      return;
    case '/help':
      await tg.sendMessage(chatId, HELP_TEXT, MAIN_MENU_KEYBOARD);
      return;
    case '/status':
      await sendStatus(chatId);
      return;
    case '/cancel': {
      pendingCustom.delete(chatId);
      const n = cancelChatJobs(chatId);
      await tg.sendMessage(chatId, n ? `🛑 ${n} download(s) cancel kiye ja rahe hain...` : 'Koi active download nahi mila.');
      return;
    }
    case '/format': {
      const v = rest.toLowerCase();
      if (v === 'epub' || v === 'txt') {
        setPrefs(chatId, { format: v });
        await tg.sendMessage(chatId, `✅ Output format: <b>${v.toUpperCase()}</b>`);
      } else {
        await tg.sendMessage(
          chatId,
          `Current format: <b>${getPrefs(chatId).format.toUpperCase()}</b>\nUse <code>/format epub</code> ya <code>/format txt</code>`
        );
      }
      return;
    }
  }

  if (text === 'ℹ️ Help') return void (await tg.sendMessage(chatId, HELP_TEXT, MAIN_MENU_KEYBOARD));
  if (text === '📊 Status') return void (await sendStatus(chatId));

  // /wtr, /wtrlab (+ bare "wtr ..." and the menu button) -> hardened handler from wtrlab_telegram_handlers.ts
  if (['/wtr', '/wtrlab', 'wtr', 'wtrlab'].includes(commandWord) || text === WTR_MENU_BUTTON) {
    pendingCustom.delete(chatId);
    await tg.sendChatAction(chatId);
    await hostFor(chatId).handleWtrCommand(chatId, text, lowerText, commandWord);
    return;
  }

  // Custom-range reply ("10-50")
  const pending = pendingCustom.get(chatId);
  if (pending && pending.expires > Date.now()) {
    const m = text.match(/^(\d{1,6})\s*(?:-|–|—|to|se)\s*(\d{1,6})$/i);
    if (!m) {
      await tg.sendMessage(chatId, `Range galat hai. Aise bhejein: <code>10-50</code> (1–${pending.total.toLocaleString()}). /cancel se wapas.`);
      return;
    }
    pendingCustom.delete(chatId);
    await startScrape(chatId, pending.token, Number(m[1]), Number(m[2]), 'custom');
    return;
  }
  pendingCustom.delete(chatId);

  // Any WTR-Lab link pasted into the chat
  const ref = extractWtrlabNovelRef(text);
  if (ref) {
    await tg.sendChatAction(chatId);
    await hostFor(chatId).openNovelCard(chatId, ref.novelId, ref.slug);
    return;
  }

  if (isPrivate) {
    await tg.sendMessage(chatId, '🤔 Samajh nahi aaya. <code>/wtr &lt;novel name / ID&gt;</code> try karein ya wtr-lab.com ka link bhejein. /help dekhein.', MAIN_MENU_KEYBOARD);
  }
}

async function sendStatus(chatId: string): Promise<void> {
  const mine = jobsForChat(chatId);
  const g = jobStats();
  if (mine.length === 0) {
    await tg.sendMessage(chatId, `📊 Aapka koi active download nahi hai.\n<i>Server: ${g.running} running · ${g.queued} queued</i>`);
    return;
  }
  const lines = mine.map((e) => {
    const j = e.job;
    return `• <b>${escapeXml(j.title || j.novelId)}</b> - ${escapeXml(j.status)} · ${j.progress}% (Ch ${j.currentChapter ?? 0}/${j.totalChapters})`;
  });
  await tg.sendMessage(chatId, `📊 <b>Your downloads</b>\n${lines.join('\n')}\n\n<i>Server: ${g.running} running · ${g.queued} queued</i>`);
}

async function onCallback(cb: any): Promise<void> {
  const chatId = String(cb?.message?.chat?.id ?? '');
  const messageId: number | undefined = cb?.message?.message_id;
  const data = String(cb?.data || '');
  if (!chatId) return void (await tg.answerCallbackQuery(cb.id));
  if (!allowed(chatId)) return void (await tg.answerCallbackQuery(cb.id, 'Access denied', true));

  const parts = data.split(':');
  const action = parts[0];

  switch (action) {
    case 'scrape': {
      const [, kind, token, n] = parts;
      const novel = getNovelByToken(token);
      if (!novel) {
        await tg.answerCallbackQuery(cb.id, 'Ye card purana ho gaya - /wtr se dobara khojein.', true);
        return;
      }
      const total = Math.max(1, Number(n) || novel.totalChapters || 1);
      if (kind === 'custom') {
        await tg.answerCallbackQuery(cb.id);
        const rangeHint = novel.hasUnverifiedCount
          ? `jaise <code>10-50</code> ya <code>1-235</code>`
          : `jaise <code>10-50</code> (1–${total.toLocaleString()})`;
        pendingCustom.set(chatId, { token, total, expires: Date.now() + PENDING_TTL_MS });
        await tg.sendMessage(
          chatId,
          `⚙️ <b>${escapeXml(novel.title)}</b>\nApni chapter range bhejein, ${rangeHint}.\n/cancel se wapas.`
        );
        return;
      }
      await tg.answerCallbackQuery(cb.id, 'Download queue me daal diya...');
      if (kind === 'demo') await startScrape(chatId, token, 1, Math.min(total, Math.max(1, Number(n) || 25)), 'demo');
      else if (kind === 'all') await startScrape(chatId, token, 1, total, 'all');
      return;
    }
    case 'togglelang': {
      const token = parts[1];
      const novel = getNovelByToken(token);
      const p = getPrefs(chatId);
      setPrefs(chatId, { language: p.language === 'hi' ? 'en' : 'hi' });
      await tg.answerCallbackQuery(cb.id, `Language: ${getPrefs(chatId).language === 'hi' ? 'हिंदी' : 'English'}`);
      if (novel && messageId) await refreshKeyboard(chatId, messageId, token, novel.totalChapters);
      return;
    }
    case 'setmode': {
      const [, mode, token] = parts;
      if (mode !== 'web' && mode !== 'webplus' && mode !== 'ai') return void (await tg.answerCallbackQuery(cb.id));
      setPrefs(chatId, { mode: mode as ServiceMode });
      await tg.answerCallbackQuery(cb.id, `Engine: ${mode.toUpperCase()}`);
      const novel = getNovelByToken(token);
      if (novel && messageId) await refreshKeyboard(chatId, messageId, token, novel.totalChapters);
      return;
    }
    case 'wtrcard': {
      await tg.answerCallbackQuery(cb.id);
      if (/^\d{1,9}$/.test(parts[1] || '')) await hostFor(chatId).openNovelCard(chatId, parts[1]);
      return;
    }
    default:
      await tg.answerCallbackQuery(cb.id);
  }
}

async function refreshKeyboard(chatId: string, messageId: number, token: string, total: number): Promise<void> {
  try {
    await tg.editReplyMarkup(chatId, messageId, hostFor(chatId).keyboardFor(token, total));
  } catch (e) {
    log.debug(`[bot] keyboard refresh failed: ${errMsg(e)}`);
  }
}

async function startScrape(chatId: string, token: string, start: number, end: number, rangeMode: 'demo' | 'all' | 'custom'): Promise<void> {
  const novel = getNovelByToken(token);
  if (!novel) {
    await tg.sendMessage(chatId, 'Ye card purana ho gaya - /wtr se dobara khojein.');
    return;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    await tg.sendMessage(chatId, 'Range galat hai (start ≥ 1 aur end ≥ start hona chahiye).');
    return;
  }
  if (rangeMode === 'custom' && !novel.hasUnverifiedCount && start > novel.totalChapters) {
    await tg.sendMessage(chatId, `Is novel me sirf <b>${novel.totalChapters.toLocaleString()}</b> chapters hain.`);
    return;
  }
  const endCh =
    rangeMode === 'custom'
      ? (novel.hasUnverifiedCount ? end : Math.min(end, Math.max(novel.totalChapters, start)))
      : end;

  const prefs = getPrefs(chatId);
  const sent = await tg.sendMessage(
    chatId,
    `⏳ <b>${escapeXml(novel.title)}</b>\nQueue me hai - Ch ${start}–${endCh} · ${prefs.format.toUpperCase()} · ${prefs.language.toUpperCase()} · ${prefs.mode.toUpperCase()}`
  );

  const job: ScrapeJob = {
    id: `job_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
    novelId: novel.novelId,
    novelUrl: novel.novelUrl,
    title: novel.title,
    author: '',
    coverUrl: novel.coverUrl,
    startChapter: start,
    totalChapters: endCh,
    progress: 0,
    status: 'queued',
    format: prefs.format,
    language: prefs.language,
    serviceMode: prefs.mode,
    chatId,
    botToken: config.botToken,
    telegramMessageId: sent?.message_id,
    createdAt: Date.now(),
  };

  const res = enqueueJob({ job, host: core.createHost(prefs), endCh, rangeMode, chatId });
  if (!res.ok) {
    const text = `⚠️ ${escapeXml(res.reason)}`;
    if (sent?.message_id) await tg.editTelegramMessage(config.botToken, chatId, sent.message_id, text).catch(() => tg.sendMessage(chatId, text));
    else await tg.sendMessage(chatId, text);
  }
}
