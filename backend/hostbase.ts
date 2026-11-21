import { Format, Lang, ScrapeJob, ServiceMode } from './types';
import { log } from './logger';
import * as tg from './telegram';
import { config } from './config';

/** Job ids flagged for cancellation. Shared by every host instance (the scraper core checks `this.cancelled`). */
export const cancelledJobs = new Set<string>();

/**
 * Base class for the generated `WtrlabHost`. It supplies the host-side members that the hardened
 * core fragments (build gate + telegram handlers) expect on `this`, while the core files stay untouched.
 */
export class HostBase {
  public cancelled = cancelledJobs;
  public defaultLanguage: Lang;
  public defaultServiceMode: ServiceMode;
  public defaultFormat: Format;

  constructor(prefs: { language: Lang; mode: ServiceMode; format: Format }) {
    this.defaultLanguage = prefs.language;
    this.defaultServiceMode = prefs.mode;
    this.defaultFormat = prefs.format;
  }

  public getServiceModeLabel(m: string): string {
    return m === 'web' ? 'Web · Original MTL' : m === 'webplus' ? 'Web+ · Glossary Enhanced' : 'AI · Clean Prose';
  }

  public ensureBuildStats(job: ScrapeJob) {
    if (!job.buildStats) {
      job.buildStats = {
        totalRequested: 0,
        verifiedCount: 0,
        retryCount: 0,
        fallbackCount: 0,
        placeholderCount: 0,
        errorCount: 0,
        warnings: [],
        errors: [],
      };
    }
    return job.buildStats;
  }

  public isPlaceholderChapter(paras: string[]): boolean {
    if (!Array.isArray(paras) || paras.length === 0) return true;
    return paras.length === 1 && /queued for (?:verification|deep verification|recovery)|could not be retrieved/i.test(paras[0]);
  }

  public pushJobLog(job: ScrapeJob, level: string, stage: string, msg: string, ch?: number): void {
    const line = `[${level.toUpperCase()}][${stage}]${ch ? ` Ch ${ch}` : ''}: ${msg}`;
    (job.logs ||= []).push(line);
    if (job.logs.length > 300) job.logs.splice(0, job.logs.length - 300);
    if (level === 'error') log.warn(`[job ${job.id}] ${line}`);
    else log.debug(`[job ${job.id}] ${line}`);
  }

  public persistState(_force: boolean): void {
    /* jobs are in-memory only; nothing to persist */
  }

  public finalizeJobStats(job: ScrapeJob): void {
    const s = this.ensureBuildStats(job);
    s.finishedAt = Date.now();
  }

  public async sendMessage(chatId: string, text: string, replyMarkup?: any): Promise<void> {
    await tg.sendMessage(chatId, text, replyMarkup);
  }

  public async sendPhoto(chatId: string, url: string, caption: string, replyMarkup?: any): Promise<void> {
    await tg.sendPhoto(chatId, url, caption, replyMarkup);
  }

  public async sendDocumentToTelegram(token: string, chatId: string, buf: Buffer, filename: string, caption: string): Promise<void> {
    await tg.sendDocumentToTelegram(token || config.botToken, chatId, buf, filename, caption);
  }
}
