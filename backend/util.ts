import fs from 'fs';
import path from 'path';
import { config } from './config';
import { log, errMsg } from './logger';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function escapeXml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function unescapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

function safeFromCodePoint(cp: number): string {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

export function atomicWriteJsonFile(file: string, data: unknown, _compact?: boolean): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
  fs.renameSync(tmp, file);
}

export function migrateLegacyFileToRuntime(legacyFile: string, runtimeFile: string): void {
  try {
    if (!fs.existsSync(runtimeFile) && fs.existsSync(legacyFile)) {
      fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
      fs.copyFileSync(legacyFile, runtimeFile);
    }
  } catch {
    /* best effort */
  }
}

export function loadBotConfig(): { translationEngine: 'gemini' | 'google' } {
  return { translationEngine: config.geminiApiKey ? 'gemini' : 'google' };
}

/** Small JSON-persisted Map (debounced atomic writes, bounded size, newest entries win). */
const persisted: Array<PersistedMap<any>> = [];

export class PersistedMap<V> {
  private map = new Map<string, V>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private file: string, private max = 5000) {
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (Array.isArray(raw)) for (const [k, v] of raw) this.map.set(String(k), v as V);
      }
    } catch (e) {
      log.warn(`Could not load ${path.basename(file)}: ${errMsg(e)}`);
    }
    persisted.push(this);
  }

  get(k: string): V | undefined {
    return this.map.get(k);
  }
  has(k: string): boolean {
    return this.map.has(k);
  }
  set(k: string, v: V): void {
    this.map.delete(k); // refresh insertion order
    this.map.set(k, v);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    this.schedule();
  }
  get size(): number {
    return this.map.size;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 1500);
    this.timer.unref?.();
  }

  flush(): void {
    try {
      atomicWriteJsonFile(this.file, Array.from(this.map.entries()));
    } catch (e) {
      log.warn(`Could not save ${path.basename(this.file)}: ${errMsg(e)}`);
    }
  }
}

export function flushAllPersisted(): void {
  for (const p of persisted) p.flush();
}

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export const RUNTIME_DIR = config.dataDir;

/**
 * fetch() wrapper handed to the scraper core. Behaviour is identical to global fetch, except
 * that r.jina.ai requests carry `Authorization: Bearer $JINA_API_KEY` when that optional key is set
 * (higher rate limits) - the core modules never need to know.
 */
export const hostFetch: typeof globalThis.fetch = (input, init) => {
  if (config.jinaApiKey) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.startsWith('https://r.jina.ai/')) {
      const headers = new Headers(init?.headers);
      if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${config.jinaApiKey}`);
      return globalThis.fetch(input, { ...init, headers });
    }
  }
  return globalThis.fetch(input, init);
};

/** setInterval that never keeps the process alive and can be cleared all at once on shutdown. */
const trackedIntervals = new Set<NodeJS.Timeout>();

export function trackedSetInterval(handler: () => void, ms?: number): NodeJS.Timeout {
  const t = setInterval(() => {
    try {
      const r: unknown = (handler as () => unknown)();
      if (r && typeof (r as Promise<unknown>).catch === 'function') {
        (r as Promise<unknown>).catch((e) => log.warn('[interval] async task failed:', errMsg(e)));
      }
    } catch (e) {
      log.warn('[interval] task failed:', errMsg(e));
    }
  }, ms);
  t.unref?.();
  trackedIntervals.add(t);
  return t;
}

export function clearTrackedIntervals(): void {
  for (const t of trackedIntervals) clearInterval(t);
  trackedIntervals.clear();
}

export function makeProgressBar(pct: number, len = 12): string {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const filled = Math.round((p / 100) * len);
  return '[' + '█'.repeat(filled) + '░'.repeat(Math.max(0, len - filled)) + ']';
}

/** Extract {novelId, slug?} from any WTR-Lab novel / chapter URL found inside a string. */
export function extractWtrlabNovelRef(raw: string): { novelId: string; slug?: string } | null {
  const m = String(raw || '').match(
    /wtr-lab\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:novel\/|serie-)(\d+)(?:\/([a-z0-9][a-z0-9_-]*))?/i
  );
  if (!m) return null;
  const slug = m[2] && !/^chapter-\d+$/i.test(m[2]) ? m[2].toLowerCase() : undefined;
  return { novelId: m[1], slug };
}
