import { config } from './config';
import { log, errMsg } from './logger';
import { sleep } from './util';

/** True when a paragraph still contains a meaningful amount of Latin (English) text. */
export function hasEnglishLeakage(p: string): boolean {
  const s = String(p || '');
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  if (latin < 6) return false;
  const deva = (s.match(/[\u0900-\u097F]/g) || []).length;
  return latin / (latin + deva) > 0.3;
}

const cache = new Map<string, string>();
const CACHE_MAX = 20000;

function cacheSet(k: string, v: string) {
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(k, v);
}

async function googleTranslateOnce(text: string): Promise<string> {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=hi&dt=t&q=' + encodeURIComponent(text);
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Google Translate HTTP ${res.status}`);
  const data: any = await res.json();
  const out = Array.isArray(data?.[0]) ? data[0].map((seg: any) => String(seg?.[0] ?? '')).join('') : '';
  if (!out.trim()) throw new Error('Google Translate returned empty text');
  return out;
}

function splitLong(text: string, max = 1400): string[] {
  if (text.length <= max) return [text];
  const sentences = text.match(/[^.!?。！？]+[.!?。！？]*\s*/g) || [text];
  const chunks: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + s).length > max && cur) {
      chunks.push(cur);
      cur = '';
    }
    cur += s;
    while (cur.length > max) {
      chunks.push(cur.slice(0, max));
      cur = cur.slice(max);
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function googleTranslate(text: string): Promise<string> {
  const key = `g:${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const parts = splitLong(text);
  const outParts: string[] = [];
  for (const part of parts) {
    let lastErr: unknown;
    let done = false;
    for (let attempt = 0; attempt < 3 && !done; attempt++) {
      try {
        outParts.push((await googleTranslateOnce(part)).trim());
        done = true;
      } catch (e) {
        lastErr = e;
        await sleep(500 * (attempt + 1));
      }
    }
    if (!done) throw lastErr;
  }
  const out = outParts.join(' ');
  cacheSet(key, out);
  return out;
}

async function geminiTranslateBatch(texts: string[]): Promise<string[]> {
  const prompt =
    'Translate each element of this JSON array of novel paragraphs from English into natural, fluent Hindi (Devanagari). ' +
    'Keep character names transliterated consistently. Return ONLY a JSON array of strings with EXACTLY the same number of elements, same order.\n' +
    JSON.stringify(texts);
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiApiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(90000),
    }
  );
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data: any = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text || '').join('') || '';
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr) || arr.length !== texts.length || arr.some((x) => typeof x !== 'string' || !x.trim())) {
    throw new Error('Gemini returned a malformed / length-mismatched array');
  }
  return arr as string[];
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

/**
 * Translate a chapter into Hindi. The paragraph COUNT is always preserved (zero-drop guarantee):
 * any paragraph that cannot be translated is kept in English rather than being removed.
 */
export async function translateParagraphsToHindi(
  paragraphs: string[],
  chapterNo: number,
  title: string,
  _novelId: string,
  engine: 'gemini' | 'google' = 'google'
): Promise<{ title: string; paragraphs: string[] }> {
  let translated: string[] | null = null;

  if (engine === 'gemini' && config.geminiApiKey) {
    try {
      // batch by size so each call stays well inside model limits
      const batches: string[][] = [];
      let cur: string[] = [];
      let size = 0;
      for (const p of paragraphs) {
        if (size + p.length > 6000 && cur.length) {
          batches.push(cur);
          cur = [];
          size = 0;
        }
        cur.push(p);
        size += p.length;
      }
      if (cur.length) batches.push(cur);
      const out: string[] = [];
      for (const b of batches) out.push(...(await geminiTranslateBatch(b)));
      translated = out;
    } catch (e) {
      log.warn(`[translate] Gemini failed for ch ${chapterNo}, falling back to Google: ${errMsg(e)}`);
    }
  }

  if (!translated) {
    translated = await mapLimit(paragraphs, 5, async (p) => {
      if (!hasEnglishLeakage(p)) return p;
      try {
        return await googleTranslate(p);
      } catch (e) {
        log.debug(`[translate] paragraph kept in English (ch ${chapterNo}): ${errMsg(e)}`);
        return p;
      }
    });
  }

  let hiTitle = title;
  try {
    hiTitle = (await googleTranslate(title)).trim() || title;
  } catch {
    /* keep English title */
  }
  if (!new RegExp(`(^|\\D)${chapterNo}(\\D|$)`).test(hiTitle)) hiTitle = `अध्याय ${chapterNo}: ${hiTitle}`;

  return { title: hiTitle, paragraphs: translated };
}
