import { config } from './config';
import { log, errMsg } from './logger';
import { cancelledJobs } from './hostbase';
import * as tg from './telegram';
import { escapeXml } from './util';
import type { ScrapeJob } from './types';
import type { WtrlabHostInstance } from './generated/wtrlab_core';

type Entry = {
  job: ScrapeJob;
  host: WtrlabHostInstance;
  endCh: number;
  rangeMode: 'demo' | 'all' | 'custom';
  chatId: string;
};

const queue: Entry[] = [];
const running = new Map<string, Entry>();
let draining = false;

export const jobStats = () => ({ running: running.size, queued: queue.length });

export function jobsForChat(chatId: string): Entry[] {
  return [...running.values(), ...queue].filter((e) => e.chatId === chatId);
}

export function enqueueJob(entry: Entry): { ok: true; position: number } | { ok: false; reason: string } {
  if (draining) return { ok: false, reason: 'Bot restart ho raha hai - thodi der baad dobara try karein.' };
  if (jobsForChat(entry.chatId).length >= config.maxJobsPerChat) {
    return {
      ok: false,
      reason: `Aapka ek download pehle se chal raha hai (limit: ${config.maxJobsPerChat}). Use /status se dekhein ya /cancel se rok dein.`,
    };
  }
  queue.push(entry);
  const position = queue.length + running.size;
  setImmediate(pump);
  return { ok: true, position };
}

export function cancelChatJobs(chatId: string): number {
  let n = 0;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].chatId === chatId) {
      const [e] = queue.splice(i, 1);
      e.job.status = 'failed';
      e.job.error = 'Cancelled by user';
      void notify(e, `🛑 <b>${escapeXml(e.job.title || 'Download')}</b> cancel kar diya gaya.`);
      n++;
    }
  }
  for (const e of running.values()) {
    if (e.chatId === chatId) {
      cancelledJobs.add(e.job.id);
      n++;
    }
  }
  return n;
}

function pump(): void {
  while (!draining && running.size < config.maxConcurrentJobs && queue.length > 0) {
    const entry = queue.shift()!;
    running.set(entry.job.id, entry);
    void run(entry);
  }
}

async function notify(e: Entry, text: string): Promise<void> {
  try {
    await tg.sendMessage(e.chatId, text);
  } catch (err) {
    log.warn(`[jobs] could not notify chat ${e.chatId}: ${errMsg(err)}`);
  }
}

async function run(e: Entry): Promise<void> {
  const { job } = e;
  try {
    log.info(`[jobs] start ${job.id} novel=${job.novelId} ch=${job.startChapter}-${e.endCh} mode=${job.serviceMode} lang=${job.language}`);
    await e.host.runJob(job, e.endCh, e.rangeMode);
  } catch (err) {
    job.status = 'failed';
    job.error = job.error || errMsg(err);
    log.warn(`[jobs] ${job.id} threw: ${job.error}`);
  }

  try {
    await report(e);
  } catch (err) {
    log.warn(`[jobs] report for ${job.id} failed: ${errMsg(err)}`);
  } finally {
    // free big buffers right away
    job.fileBuffer = undefined;
    job.chapters = undefined;
    cancelledJobs.delete(job.id);
    running.delete(job.id);
    log.info(`[jobs] end ${job.id} status=${job.status}`);
    setImmediate(pump);
  }
}

async function report(e: Entry): Promise<void> {
  const { job } = e;
  const stats = job.buildStats || {};
  const title = escapeXml(job.title || `Novel #${job.novelId}`);

  if (job.status === 'completed') {
    if (stats.telegramDelivered) return;
    // Core produced a verified file but the upload failed: retry the upload (never re-scrape).
    if (job.fileBuffer && job.filename) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await tg.sendDocumentToTelegram(
            config.botToken,
            e.chatId,
            job.fileBuffer,
            job.filename,
            `✅ <b>${title}</b>\n📑 Chapters: <b>${job.startChapter}–${job.chapters?.[job.chapters.length - 1]?.num ?? job.totalChapters}</b> (verified)`
          );
          stats.telegramDelivered = true;
          return;
        } catch (err) {
          log.warn(`[jobs] upload retry ${attempt}/3 for ${job.id}: ${errMsg(err)}`);
          if (/50 MB/.test(errMsg(err))) {
            await notify(e, `⚠️ <b>${title}</b>: ${escapeXml(errMsg(err))}`);
            return;
          }
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
    }
    await notify(e, `⚠️ <b>${title}</b> ban gaya lekin Telegram par upload nahi ho paya. Kripya dobara try karein.`);
    return;
  }

  // failed / cancelled / blocked
  const reason = job.error || 'Unknown error';
  const cancelled = /cancel/i.test(reason);
  const blocked = /Verification Failed/i.test(reason);
  const hint = blocked
    ? `\n\n💡 Tip: abhi sirf kuch chapters fetch nahi ho paaye (temporary). Kripya <b>kuch der baad dobara</b> try karein - jo chapters ban chuke hain wo cache me hain, isliye agli baar tez hoga. Agar phir bhi fail ho to <b>Web+</b> ya <b>Web</b> engine select karke ya chhoti range (jaise 1-100) se try karein.`
    : `\n\nKripya kuch der baad dobara try karein.`;
  const text = cancelled
    ? `🛑 <b>${title}</b> cancel kar diya gaya.`
    : `❌ <b>${title}</b> download fail hua.\n<code>${escapeXml(reason.slice(0, 600))}</code>${hint}`;
  if (job.chatId && job.telegramMessageId) {
    await tg.editTelegramMessage(config.botToken, job.chatId, job.telegramMessageId, text).catch(() => notify(e, text));
  } else {
    await notify(e, text);
  }
}

/** Stop accepting jobs, give running ones `graceMs` to finish, then cancel + notify whatever is left. */
export async function drainJobs(graceMs: number): Promise<void> {
  draining = true;
  const waiting = queue.splice(0, queue.length);
  for (const e of waiting) {
    e.job.status = 'failed';
    e.job.error = 'Bot restarted';
    await notify(e, `🔄 Bot restart ho raha hai - <b>${escapeXml(e.job.title || 'download')}</b> start nahi ho paya. Kripya dobara request karein.`);
  }
  const deadline = Date.now() + graceMs;
  while (running.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  for (const e of running.values()) {
    cancelledJobs.add(e.job.id);
    await notify(e, `🔄 Bot restart ho raha hai - <b>${escapeXml(e.job.title || 'download')}</b> beech me ruk gaya. Kripya dobara request karein.`);
  }
}
