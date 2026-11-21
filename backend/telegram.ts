import { config } from './config';
import { log, errMsg } from './logger';
import { sleep } from './util';

export class TelegramError extends Error {
  constructor(message: string, public code: number, public retryAfter?: number) {
    super(message);
    this.name = 'TelegramError';
  }
}

type Json = Record<string, any>;

const API = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');

function isTransient(e: unknown): boolean {
  if (e instanceof TelegramError) return e.code === 429 || e.code >= 500;
  const msg = `${(e as any)?.name || ''} ${(e as any)?.message || ''} ${(e as any)?.cause?.code || ''}`;
  return /fetch failed|timeout|abort|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket|network|UND_ERR/i.test(msg);
}

async function request<T>(
  method: string,
  body: Json | FormData,
  opts: { token?: string; timeoutMs?: number; retries?: number } = {}
): Promise<T> {
  const token = opts.token || config.botToken;
  const retries = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 30000;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
      const res = await fetch(`${API}/bot${token}/${method}`, {
        method: 'POST',
        headers: isForm ? undefined : { 'Content-Type': 'application/json' },
        body: isForm ? (body as FormData) : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      let data: any = null;
      try {
        data = await res.json();
      } catch {
        /* non-JSON body */
      }
      if (res.ok && data?.ok) return data.result as T;
      const code = Number(data?.error_code || res.status);
      throw new TelegramError(
        String(data?.description || `HTTP ${res.status}`),
        code,
        Number(data?.parameters?.retry_after) || undefined
      );
    } catch (e) {
      lastErr = e;
      if (attempt >= retries || !isTransient(e)) break;
      const wait =
        e instanceof TelegramError && e.retryAfter
          ? Math.min(e.retryAfter, 30) * 1000 + 250
          : Math.min(8000, 700 * 2 ** attempt) + Math.floor(Math.random() * 300);
      log.warn(`[telegram] ${method} failed (${errMsg(e)}) - retry ${attempt + 1}/${retries} in ${wait}ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

const stripTags = (s: string) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

function clip(text: string, max: number): string {
  const t = String(text ?? '');
  return t.length <= max ? t : t.slice(0, max - 1) + '…';
}

const isParseError = (e: unknown) => e instanceof TelegramError && /can't parse entities|unsupported start tag|can't find end/i.test(e.message);

export async function sendMessage(chatId: string | number, text: string, replyMarkup?: any, token?: string): Promise<any> {
  const payload: Json = {
    chat_id: chatId,
    text: clip(text, 4096),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  try {
    return await request('sendMessage', payload, { token });
  } catch (e) {
    if (!isParseError(e)) throw e;
    return request('sendMessage', { ...payload, text: clip(stripTags(text), 4096), parse_mode: undefined }, { token });
  }
}

export async function sendPhoto(chatId: string | number, photoUrl: string, caption: string, replyMarkup?: any, token?: string): Promise<any> {
  const payload: Json = { chat_id: chatId, photo: photoUrl, caption: clip(caption, 1024), parse_mode: 'HTML' };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  try {
    return await request('sendPhoto', payload, { token, retries: 1 });
  } catch (e) {
    if (!isParseError(e)) throw e;
    return request('sendPhoto', { ...payload, caption: clip(stripTags(caption), 1024), parse_mode: undefined }, { token, retries: 1 });
  }
}

/** Edit a message's text. Silently ignores "message is not modified". Always returns a Promise. */
export async function editTelegramMessage(
  token: string,
  chatId: string | number,
  messageId: number,
  text: string,
  replyMarkup?: any
): Promise<void> {
  const payload: Json = {
    chat_id: chatId,
    message_id: messageId,
    text: clip(text, 4096),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  try {
    await request('editMessageText', payload, { token, retries: 1 });
  } catch (e) {
    if (e instanceof TelegramError && /not modified/i.test(e.message)) return;
    if (isParseError(e)) {
      await request('editMessageText', { ...payload, text: clip(stripTags(text), 4096), parse_mode: undefined }, { token, retries: 1 }).catch(() => {});
      return;
    }
    throw e;
  }
}

export async function editReplyMarkup(chatId: string | number, messageId: number, replyMarkup: any): Promise<void> {
  try {
    await request('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup }, { retries: 1 });
  } catch (e) {
    if (e instanceof TelegramError && /not modified/i.test(e.message)) return;
    throw e;
  }
}

export async function answerCallbackQuery(id: string, text?: string, showAlert = false): Promise<void> {
  await request('answerCallbackQuery', { callback_query_id: id, text: text ? clip(text, 200) : undefined, show_alert: showAlert }, { retries: 1, timeoutMs: 10000 }).catch(
    (e) => log.debug('[telegram] answerCallbackQuery failed:', errMsg(e))
  );
}

export const TELEGRAM_MAX_UPLOAD_BYTES = 49 * 1024 * 1024;

export async function sendDocumentToTelegram(
  token: string,
  chatId: string | number,
  fileBuffer: Buffer,
  filename: string,
  caption?: string
): Promise<any> {
  if (fileBuffer.length > TELEGRAM_MAX_UPLOAD_BYTES) {
    throw new Error(
      `File is ${(fileBuffer.length / 1048576).toFixed(1)} MB - Telegram bots can upload at most 50 MB. Please download a smaller chapter range.`
    );
  }
  const build = (withHtml: boolean) => {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) {
      form.append('caption', clip(withHtml ? caption : stripTags(caption), 1024));
      if (withHtml) form.append('parse_mode', 'HTML');
    }
    form.append('document', new Blob([new Uint8Array(fileBuffer)]), filename);
    return form;
  };
  try {
    return await request('sendDocument', build(true), { token, timeoutMs: 180000, retries: 2 });
  } catch (e) {
    if (!isParseError(e)) throw e;
    return request('sendDocument', build(false), { token, timeoutMs: 180000, retries: 2 });
  }
}

export const getMe = (token?: string) => request<{ id: number; username: string }>('getMe', {}, { token, retries: 2, timeoutMs: 15000 });

export const setMyCommands = (commands: Array<{ command: string; description: string }>) =>
  request('setMyCommands', { commands }, { retries: 1, timeoutMs: 15000 });

export const setWebhook = (url: string, secretToken: string) =>
  request('setWebhook', { url, secret_token: secretToken, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false }, { retries: 3 });

export const deleteWebhook = () => request('deleteWebhook', { drop_pending_updates: false }, { retries: 3, timeoutMs: 15000 });

export const sendChatAction = (chatId: string | number, action = 'typing') =>
  request('sendChatAction', { chat_id: chatId, action }, { retries: 0, timeoutMs: 8000 }).catch(() => {});

export function getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<any[]> {
  // Single attempt: the polling loop owns retry/backoff so shutdown can interrupt it.
  const token = config.botToken;
  return (async () => {
    const res = await fetch(`${API}/bot${token}/getUpdates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout((timeoutSec + 15) * 1000)]) : AbortSignal.timeout((timeoutSec + 15) * 1000),
    });
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      /* ignore */
    }
    if (res.ok && data?.ok) return data.result as any[];
    throw new TelegramError(String(data?.description || `HTTP ${res.status}`), Number(data?.error_code || res.status), Number(data?.parameters?.retry_after) || undefined);
  })();
}
