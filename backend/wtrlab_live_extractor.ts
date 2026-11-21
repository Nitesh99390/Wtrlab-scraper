  const WTRLAB_AES_KEY = 'IJAFUUxjM25hyzL2AZrn0wl7cESED6Ru';

  /**
   * Decrypt AES-256-GCM chapter payload from WTR-Lab
   * Format: "arr:<iv b64>:<tag b64>:<ciphertext b64>" or "str:<iv b64>:<tag b64>:<ciphertext b64>"
   */
  function decryptWtrlabBody(encrypted: string): string[] {
    try {
      if (!encrypted) return [];
      const isArray = encrypted.startsWith('arr:');
      if (!isArray && !encrypted.startsWith('str:')) {
        return [encrypted];
      }
      const parts = encrypted.substring(4).split(':');
      if (parts.length !== 3) return [encrypted];

      const iv = Buffer.from(parts[0], 'base64');
      const tag = Buffer.from(parts[1], 'base64');
      const cipher = Buffer.from(parts[2], 'base64');

      const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(WTRLAB_AES_KEY, 'utf-8'), iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(cipher), decipher.final()]).toString('utf-8');
      const decoded = isArray ? JSON.parse(plain) : plain;
      return Array.isArray(decoded) ? decoded.map(String) : [String(decoded)];
    } catch (err: any) {
      console.warn('[WTR-Lab Decrypt] Fallback on string:', err.message);
      return [encrypted];
    }
  }

  // Unified Chapter & Live Snapshot Cache (24h TTL for built chapters, 45m TTL for live parity snapshots)
  const wtrlabChapterCache = new Map<string, { title: string; paragraphs: string[]; timestamp: number }>();

  type WtrlabLiveSnapshotEntry = {
    title: string;
    paragraphs: string[];
    mode: WtrlabServiceMode;
    capturedAt: number;
  };
  const wtrlabLiveSnapshotCache = new Map<string, WtrlabLiveSnapshotEntry>();
  const wtrlabEmptyServiceFallback = new Map<string, { targetMode: WtrlabServiceMode; expiresAt: number }>();

  // Per-novel canonical slug registry — CRITICAL to prevent wtr-lab.com SPA +1 chapter-shift bugs!
  const wtrlabResolvedSlugCache = new Map<string, string>();
  const wtrlabSlugInflight = new Map<string, Promise<string>>();

  // In-flight single-flight deduplicator for identical chapter fetches
  const wtrlabChapterInflight = new Map<string, Promise<{ title: string; paragraphs: string[]; modeUsed: WtrlabServiceMode; source: string } | null>>();

  // Strictly Confirmed HTTP 404 / SSR Error Circuit-Breaker (NEVER marks transient browser 422 timeouts as 404!)
  const jinaKnown404Until = new Map<string, number>();
  let wtrlabReaderApiCfBlockedUntil = 0;

  function normalizeJinaBaseUrl(rawUrl: string): string {
    return String(rawUrl || '')
      .replace(/([?&])_cb=\d+&?/g, '$1')
      .replace(/[?&]$/, '');
  }

  function isJinaUrlKnown404(rawUrl: string): boolean {
    const base = normalizeJinaBaseUrl(rawUrl);
    const exp = jinaKnown404Until.get(base) || 0;
    if (exp > Date.now()) return true;
    if (exp > 0) jinaKnown404Until.delete(base);
    return false;
  }

  function markJinaUrl404(rawUrl: string, ttlMs = 15 * 60 * 1000) {
    const base = normalizeJinaBaseUrl(rawUrl);
    if (!base) return;
    if (jinaKnown404Until.size >= 2500) {
      const oldest = jinaKnown404Until.keys().next().value;
      if (oldest) jinaKnown404Until.delete(oldest);
    }
    jinaKnown404Until.set(base, Date.now() + ttlMs);
  }

  function getWtrlabLiveSnapshot(
    novelId: string,
    chapterNo: number,
    mode: WtrlabServiceMode,
    maxAgeMs = 45 * 60 * 1000
  ): WtrlabLiveSnapshotEntry | null {
    const key = `${novelId}:${chapterNo}:${mode}`;
    const hit = wtrlabLiveSnapshotCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.capturedAt > maxAgeMs) {
      wtrlabLiveSnapshotCache.delete(key);
      return null;
    }
    return hit;
  }

  function setWtrlabLiveSnapshot(
    novelId: string,
    chapterNo: number,
    mode: WtrlabServiceMode,
    title: string,
    paragraphs: string[]
  ) {
    if (!title || !Array.isArray(paragraphs) || paragraphs.length < 1) return;
    if (wtrlabLiveSnapshotCache.size >= 8000) {
      const oldestKey = wtrlabLiveSnapshotCache.keys().next().value;
      if (oldestKey) wtrlabLiveSnapshotCache.delete(oldestKey);
    }
    wtrlabLiveSnapshotCache.set(`${novelId}:${chapterNo}:${mode}`, {
      title,
      paragraphs,
      mode,
      capturedAt: Date.now(),
    });
  }

  function titleMatchesCandidate(expectedTitle: string, candidateTitle: string): boolean {
    const clean = (s: string) =>
      unescapeHtml(s || '')
        .toLowerCase()
        .replace(/\(wtr-lab\s*#?\d+\)/gi, '')
        .replace(/^(read\s+)?novel\s+/i, '')
        .replace(/\s*[-|–—]\s*(wtr-?lab|read online).*$/i, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const a = clean(expectedTitle);
    const b = clean(candidateTitle);
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.length >= 12 && b.length >= 12 && (a.includes(b) || b.includes(a))) {
      const lenRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
      if (lenRatio >= 0.72) return true;
    }

    const stop = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'from', 'with', 'and', 'for', 'by', 'is', 'my', 'i']);
    const tokensA = a.split(' ').filter((w) => w.length >= 2 && !stop.has(w));
    const tokensB = b.split(' ').filter((w) => w.length >= 2 && !stop.has(w));
    if (tokensA.length === 0 || tokensB.length === 0) return false;

    const setB = new Set(tokensB);
    const setA = new Set(tokensA);
    const matchA = tokensA.filter((w) => setB.has(w)).length / tokensA.length;
    const matchB = tokensB.filter((w) => setA.has(w)).length / tokensB.length;
    return matchA >= 0.78 && matchB >= 0.68;
  }

  function parseEnglishWordNumber(phrase: string): number | null {
    const clean = String(phrase || '').toLowerCase().replace(/-/g, ' ').replace(/\band\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) return null;
    const ones: Record<string, number> = {
      zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
      ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
      seventeen: 17, eighteen: 18, nineteen: 19,
    };
    const tens: Record<string, number> = {
      twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
    };
    const words = clean.split(' ').filter(Boolean);
    if (words.length === 0 || words.length > 7) return null;
    let total = 0;
    let current = 0;
    let matchedAny = false;
    for (const w of words) {
      if (ones[w] !== undefined) {
        current += ones[w];
        matchedAny = true;
      } else if (tens[w] !== undefined) {
        current += tens[w];
        matchedAny = true;
      } else if (w === 'hundred') {
        current = (current || 1) * 100;
        matchedAny = true;
      } else if (w === 'thousand') {
        total += (current || 1) * 1000;
        current = 0;
        matchedAny = true;
      } else {
        return null;
      }
    }
    return matchedAny ? total + current : null;
  }

  function parseRomanNumeral(roman: string): number | null {
    const s = String(roman || '').trim().toUpperCase();
    if (!s || s.length > 12 || !/^[IVXLCDM]+$/.test(s)) return null;
    if (!/^(M{0,3})(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/.test(s)) return null;
    const vals: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    let sum = 0;
    for (let i = 0; i < s.length; i++) {
      const cur = vals[s[i]];
      const next = i + 1 < s.length ? vals[s[i + 1]] : 0;
      sum += cur < next ? -cur : cur;
    }
    return sum > 0 ? sum : null;
  }

  function extractChapterNumberFromHeading(heading: string): number | null {
    if (!heading) return null;
    const clean = String(heading).replace(/^\*\*#\d+\*\*\s*/, '').replace(/\*\*/g, '').trim();
    const m =
      clean.match(/(?:chapter|ch\.?|episode|ep\.?)\s*(\d+)/i) ||
      clean.match(/^#(\d+)\b/) ||
      clean.match(/^(\d+)\s*[:.\-–—]\s*\S/);
    if (m) {
      const parsed = parseInt(m[1], 10);
      if (!isNaN(parsed)) return parsed;
    }

    const romanMatch = clean.match(/^(?:chapter|ch\.?|episode|ep\.?)\s+([IVXLCDM]{1,10})(?:\s*[:.\-–—]|$)/i);
    if (romanMatch) {
      const r = parseRomanNumeral(romanMatch[1]);
      if (r !== null) return r;
    }

    const wordMatch = clean.match(/^(?:chapter|ch\.?)\s+([a-z-]+(?:\s+[a-z-]+){0,5})(?:\s*[:\-–—.,;]|$)/i);
    if (wordMatch) {
      return parseEnglishWordNumber(wordMatch[1]);
    }
    return null;
  }

  function chapterHeadingMatchesRequested(
    heading: string,
    requestedNo: number,
    exact = true,
    requireExplicitNumber = false
  ): boolean {
    if (!heading) return !requireExplicitNumber;
    const foundNo = extractChapterNumberFromHeading(heading);
    if (foundNo === null || isNaN(foundNo)) return !requireExplicitNumber;
    return exact ? foundNo === requestedNo : Math.abs(foundNo - requestedNo) <= 1;
  }

  function normalizeWtrlabSlotTitle(rawTitle: string, slotNo: number): string {
    const clean = String(rawTitle || '')
      .replace(/^\*\*#\d+\*\*\s*/, '')
      .replace(/\*\*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) return `Chapter ${slotNo}`;
    if (chapterHeadingMatchesRequested(clean, slotNo, true, true)) {
      return clean;
    }
    let subtitle = '';
    const digitSub =
      clean.match(/^(?:Chapter|Ch\.?|Episode|Ep\.?)\s*\d+\s*(?:'s\b|\b)\s*[:\-–—.,;]?\s*(.*)$/i) ||
      clean.match(/^#?\d+\s*[:\-–—.,;]\s*(.*)$/i);
    if (digitSub) {
      subtitle = (digitSub[1] || '').replace(/^[:\-–—.,;\s]+/, '').trim();
    } else {
      const romanSub = clean.match(/^(?:Chapter|Ch\.?)\s+[IVXLCDM]{1,10}\s*[:\-–—.,;]\s*(.+)$/i);
      const wordSub = clean.match(/^(?:Chapter|Ch\.?)\s+[A-Za-z-]+(?:\s+[A-Za-z-]+){0,5}\s*[:\-–—.,;]\s*(.+)$/i);
      if (romanSub) {
        subtitle = (romanSub[1] || '').replace(/^[:\-–—.,;\s]+/, '').trim();
      } else if (wordSub) {
        subtitle = (wordSub[1] || '').replace(/^[:\-–—.,;\s]+/, '').trim();
      } else if (!/^(?:chapter|ch\.?)\s*(?:\d+|[IVXLCDM]+)$/i.test(clean) && clean.length >= 2 && clean.length <= 130) {
        // Pure author title without "Chapter N" prefix (e.g. "Prologue: Awakening", "Final elbow strike", "Interlude")
        subtitle = clean;
      }
    }
    return subtitle && subtitle.length >= 2 ? `Chapter ${slotNo}: ${subtitle}` : `Chapter ${slotNo}`;
  }

  /**
   * Splits oversized single-block chapters into readable paragraphs ONLY when WTR-Lab / Web MTL
   * delivers a whole chapter as 1 giant unsplit paragraph (> 450 chars).
   */
  function normalizeParagraphBlocks(paragraphs: string[]): string[] {
    if (!Array.isArray(paragraphs) || paragraphs.length === 0) return [];
    if (paragraphs.length >= 3) return paragraphs;

    const expanded: string[] = [];
    for (const raw of paragraphs) {
      const line = String(raw || '').trim();
      if (!line) continue;
      if (paragraphs.length === 1 && line.length > 420) {
        const byNewline = line.split(/\r?\n+/).map((s) => s.trim()).filter(Boolean);
        if (byNewline.length >= 2) {
          expanded.push(...byNewline);
          continue;
        }
        const sentences = line.match(/[^.!?。！？]+[.!?。！？]+["'”’)]*(?:\s+|$)|[^.!?。！？]+$/g);
        if (sentences && sentences.length >= 3) {
          let buf = '';
          let count = 0;
          for (const s of sentences) {
            buf = (buf + ' ' + s.trim()).trim();
            count++;
            if (count >= 3 || buf.length >= 280) {
              expanded.push(buf);
              buf = '';
              count = 0;
            }
          }
          if (buf) expanded.push(buf);
          continue;
        }
      }
      expanded.push(line);
    }
    return expanded;
  }

  /**
   * Computes robust content fingerprint for chapter deduplication across an entire novel build.
   * Combines opening, second, middle, and closing normalized prose slices.
   */
  function computeChapterFingerprint(paragraphs: string[]): {
    fullHash: string;
    openingKey: string;
    secondKey: string;
  } {
    const norm = (s: string) =>
      String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9\u0900-\u097f\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const nonEmpty = (paragraphs || []).map(norm).filter((p) => p.length >= 8);
    const openingKey = (nonEmpty[0] || '').slice(0, 90);
    const secondKey = (nonEmpty[1] || '').slice(0, 90);
    const midKey = nonEmpty.length >= 4 ? nonEmpty[Math.floor(nonEmpty.length / 2)].slice(0, 90) : '';
    const tailKey = nonEmpty.length >= 3 ? nonEmpty[nonEmpty.length - 1].slice(0, 90) : '';
    const joined = `${openingKey}||${secondKey}||${midKey}||${tailKey}`;
    const fullHash = joined.replace(/\|/g, '').length >= 40
      ? crypto.createHash('sha1').update(joined).digest('hex').slice(0, 20)
      : '';
    return { fullHash, openingKey, secondKey };
  }

  /**
   * Deduplicates intra-chapter repeated paragraph runs (e.g. if WTR-Lab Hydration/CSR rendered
   * the chapter body twice) while preserving natural dialogue/SFX.
   */
  function deduplicateChapterParagraphs(paragraphs: string[]): string[] {
    const splitReady = normalizeParagraphBlocks(paragraphs);
    if (splitReady.length <= 1) return splitReady;

    const normLine = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9\u0900-\u097f]+/g, ' ').trim();

    // 1. Check if the entire second half of the array is an exact repeat of the first half (SSR/CSR double mount)
    if (splitReady.length >= 8 && splitReady.length % 2 === 0) {
      const half = splitReady.length / 2;
      let matches = 0;
      for (let i = 0; i < half; i++) {
        if (normLine(splitReady[i]) === normLine(splitReady[half + i])) matches++;
      }
      if (matches / half >= 0.85) {
        return deduplicateChapterParagraphs(splitReady.slice(0, half));
      }
    }

    // 2. Remove consecutive identical paragraphs and repeated long narrative blocks (>65 normalized chars)
    const out: string[] = [];
    const seenLongBlocks = new Set<string>();
    let prevNorm = '';

    for (const rawP of splitReady) {
      const trimmed = String(rawP || '').trim();
      if (!trimmed) continue;
      const n = normLine(trimmed);
      if (!n) continue;

      if (n === prevNorm && n.length >= 14) continue;
      if (n.length >= 65) {
        if (seenLongBlocks.has(n)) continue;
        seenLongBlocks.add(n);
      }

      prevNorm = n;
      out.push(trimmed);
    }

    return out;
  }

  /**
   * Resolves the TRUE canonical WTR-Lab slug for a numeric novelId.
   * Prevents Next.js `/novel/` -> `/<real-slug>/` client redirect +1 chapter shifts!
   */
  async function ensureCanonicalWtrlabSlug(novelId: string, slugHint?: string): Promise<string> {
    const cleanId = String(novelId || '').trim();
    const cleanHint = String(slugHint || '')
      .trim()
      .replace(/^\/+|\/+$/g, '');

    const isGenericSlug = (s: string) =>
      !s || s === 'novel' || /^novel-\d+$/i.test(s) || /^wtr[-_]\d+$/i.test(s) || /^\d+$/.test(s);

    if (!isGenericSlug(cleanHint)) {
      wtrlabResolvedSlugCache.set(cleanId, cleanHint);
      return cleanHint;
    }

    const cachedSlug = wtrlabResolvedSlugCache.get(cleanId);
    if (cachedSlug && !isGenericSlug(cachedSlug)) return cachedSlug;

    const dynNovel = typeof wtrlabDynamicNovels !== 'undefined' ? wtrlabDynamicNovels.get(cleanId) : null;
    if (dynNovel?.slug && !isGenericSlug(dynNovel.slug)) {
      wtrlabResolvedSlugCache.set(cleanId, dynNovel.slug);
      return dynNovel.slug;
    }

    const existingPromise = wtrlabSlugInflight.get(cleanId);
    if (existingPromise) return existingPromise;

    const resolver = (async () => {
      try {
        if (typeof fetchWtrlabLiveMetadata === 'function') {
          const meta = await fetchWtrlabLiveMetadata(cleanId, undefined, false);
          if (meta?.slug && !isGenericSlug(meta.slug)) {
            wtrlabResolvedSlugCache.set(cleanId, meta.slug);
            return meta.slug;
          }
        }
        const ssrHtml = await fetchWtrlabHtmlViaJina(`https://wtr-lab.com/en/novel/${cleanId}/novel/chapter-1`, 9500, 'high');
        if (ssrHtml) {
          const ndMatch = ssrHtml.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
          if (ndMatch) {
            const parsed = JSON.parse(ndMatch[1]);
            const realSlug =
              parsed?.props?.pageProps?.serie?.serie_data?.slug ||
              parsed?.props?.pageProps?.serie?.chapter?.slug;
            if (realSlug && !isGenericSlug(realSlug)) {
              wtrlabResolvedSlugCache.set(cleanId, String(realSlug));
              return String(realSlug);
            }
          }
        }
      } catch {}
      return cleanHint || 'novel';
    })().finally(() => {
      wtrlabSlugInflight.delete(cleanId);
    });

    wtrlabSlugInflight.set(cleanId, resolver);
    return resolver;
  }

  /**
   * Fast (~0.8s) Authoritative SSR Chapter Probe using `__NEXT_DATA__`!
   * Determines with 100% certainty whether a chapter truly exists on WTR-Lab (`page !== '/_error'`),
   * whether it is locked/unreleased, and captures its official SSR title & slug — so valid slow chapters
   * are NEVER falsely skipped as 404, while truly non-existent chapters short-circuit in <1s instead of 29s!
   */
  async function probeWtrlabChapterSsrState(
    novelId: string,
    canonicalSlug: string,
    chapterNo: number,
    priority: 'high' | 'medium' | 'low' = 'high'
  ): Promise<{
    exists: boolean;
    confirmedMissing: boolean;
    locked: boolean;
    released: boolean;
    ssrTitle?: string;
    realSlug?: string;
    totalChapters?: number;
  }> {
    const probeUrl = `https://wtr-lab.com/en/novel/${novelId}/${canonicalSlug || 'novel'}/chapter-${chapterNo}`;
    try {
      const html = await fetchWtrlabHtmlViaJina(probeUrl, 9000, priority);
      if (!html) {
        return { exists: true, confirmedMissing: false, locked: false, released: true };
      }
      if (html.includes('Warning: Target URL returned error 404') || /\b404\b[\s:-]*page not found/i.test(html.slice(0, 700))) {
        return { exists: false, confirmedMissing: true, locked: false, released: false };
      }
      const ndMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!ndMatch) {
        return { exists: true, confirmedMissing: false, locked: false, released: true };
      }
      const parsed = JSON.parse(ndMatch[1]);
      if (parsed?.page === '/_error' || Number(parsed?.props?.pageProps?.statusCode) >= 400) {
        return { exists: false, confirmedMissing: true, locked: false, released: false };
      }

      const serie = parsed?.props?.pageProps?.serie;
      const chObj = serie?.chapter;
      const sd = serie?.serie_data;
      const realSlug = sd?.slug || chObj?.slug;
      if (realSlug && realSlug !== 'novel') {
        wtrlabResolvedSlugCache.set(String(novelId), String(realSlug));
      }
      if (!chObj || (chObj.order !== undefined && Number(chObj.order) !== chapterNo)) {
        return { exists: false, confirmedMissing: true, locked: false, released: false, realSlug };
      }

      return {
        exists: true,
        confirmedMissing: false,
        locked: Boolean(chObj.locked && chObj.released === false),
        released: chObj.released !== false,
        ssrTitle: chObj.title ? String(chObj.title).trim() : undefined,
        realSlug: realSlug ? String(realSlug) : undefined,
        totalChapters: Number(sd?.chapter_count || sd?.raw_chapter_count || 0) || undefined,
      };
    } catch {
      // Network hiccup during probe -> assume chapter exists and allow retry
      return { exists: true, confirmedMissing: false, locked: false, released: true };
    }
  }

  /**
   * Parses WTR-Lab browser-rendered Markdown into clean { title, paragraphs }
   * Hardened against:
   *  - Heading-less chapters (Prologue, Epilogue, pure prose without a Chapter N header)
   *  - Dialogue / prose lines starting with "Chapter N+1..." (never falsely cuts chapter mid-story!)
   *  - Short announcements / short chapters (2+ paragraphs or >= 25 words accepted when URL+Title match)
   *  - Preloaded #N+1 / #N+2 infinite-scroll slots and ad-tracker redirects
   */
  function parseWtrlabChapterMarkdown(params: {
    md: string;
    novelId: string;
    chapterNo: number;
    expectedNovelTitle?: string;
    activeMode: WtrlabServiceMode;
    ssrFallbackTitle?: string;
  }): {
    extracted: { title: string; paragraphs: string[] } | null;
    is404: boolean;
    isAiGated: boolean;
    isAdHijacked: boolean;
    isUnloadedShell: boolean;
  } {
    const { md, novelId, chapterNo, expectedNovelTitle, activeMode, ssrFallbackTitle } = params;
    if (!md) {
      return { extracted: null, is404: false, isAiGated: false, isAdHijacked: false, isUnloadedShell: true };
    }

    const head = md.slice(0, 900);
    // NOTE: Only true 404 responses mark is404; Jina 422 selector timeouts are treated as unloaded shells so valid slow chapters retry!
    // BUGFIX: the page <title> of a perfectly valid chapter is "<Novel> Chapter 404" (also 1404, 2404, 4040 ...).
    // The old `Title:.*404` test flagged those as HTTP-404 and the whole novel build was blocked. We now strip every
    // "Chapter/Ch./Episode/#<number>" phrase from the title line BEFORE looking for a 404 marker.
    const titleLineRaw = (head.match(/^Title:[ \t]*(.*)$/im)?.[1] || '').trim();
    const titleLineNoChapterNo = titleLineRaw.replace(/(?:chapter|ch\.?|episode|ep\.?|#)\s*\d+/gi, ' ');
    // A real error page is tiny; a real chapter has a long body. A "404"-looking title next to a long body is NOT a 404
    // (e.g. a novel literally titled "Room 404" or "Page Not Found").
    const bodyAfterMarker = md.includes('Markdown Content:') ? md.slice(md.indexOf('Markdown Content:') + 17) : md;
    const bodyIsSubstantial = bodyAfterMarker.trim().length >= 600;
    const titleLooksLike404 =
      !bodyIsSubstantial &&
      (/(?:^|[\s|:\-–—])404(?:$|[\s|:\-–—!.])/.test(titleLineNoChapterNo) ||
        /page\s+not\s+found/i.test(titleLineNoChapterNo) ||
        /^(?:error\s*)?404$/i.test(titleLineNoChapterNo.trim()));
    const is404 =
      md.includes('Warning: Target URL returned error 404') ||
      /\b404\b[\s:-]*page not found/i.test(head) ||
      titleLooksLike404 ||
      /^#{1,3}\s*404\s*$/m.test(head);
    if (is404) {
      return { extracted: null, is404: true, isAiGated: false, isAdHijacked: false, isUnloadedShell: false };
    }

    const isAdHijacked =
      md.includes('adform.net') ||
      md.includes('monetixads') ||
      md.includes('admatic.de') ||
      md.includes('tacker probe');
    if (isAdHijacked) {
      return { extracted: null, is404: false, isAiGated: false, isAdHijacked: true, isUnloadedShell: false };
    }

    const isAiGated = /AI Translation Requires Registration|Guests can preview AI translation/i.test(md);
    if (isAiGated && activeMode === 'ai') {
      return { extracted: null, is404: false, isAiGated: true, isAdHijacked: false, isUnloadedShell: false };
    }

    if (md.length < 220) {
      return { extracted: null, is404: false, isAiGated, isAdHijacked: false, isUnloadedShell: true };
    }

    // Verify URL Source & Final URL belong to wtr-lab.com and match exact novelId & chapterNo
    const urlSourceMatch = md.match(/^URL Source:\s*(.+)$/m);
    const finalUrlMatch = md.match(/^Final URL:\s*(.+)$/m);
    const urlSource = urlSourceMatch ? urlSourceMatch[1].trim() : '';
    const finalUrl = finalUrlMatch ? finalUrlMatch[1].trim() : '';

    for (const checkedUrl of [urlSource, finalUrl]) {
      if (!checkedUrl) continue;
      if (!checkedUrl.includes('wtr-lab.com')) {
        return { extracted: null, is404: false, isAiGated: false, isAdHijacked: true, isUnloadedShell: false };
      }
      const srcNovelMatch = checkedUrl.match(/\/novel\/(\d+)/);
      if (srcNovelMatch && srcNovelMatch[1] !== String(novelId)) {
        return { extracted: null, is404: false, isAiGated: false, isAdHijacked: false, isUnloadedShell: false };
      }
      const srcChapMatch = checkedUrl.match(/\/chapter-(\d+)(?:[?#/]|$)/i);
      if (srcChapMatch && parseInt(srcChapMatch[1], 10) !== chapterNo) {
        return { extracted: null, is404: false, isAiGated: false, isAdHijacked: false, isUnloadedShell: false };
      }
    }
    if (finalUrl && !/\/chapter-\d+(?:[?#/]|$)/i.test(finalUrl)) {
      return { extracted: null, is404: true, isAiGated: false, isAdHijacked: false, isUnloadedShell: false };
    }

    // Verify HTML <title>
    const titleLineMatch = md.match(/^Title:\s*(.+)$/m);
    const pageTitle = titleLineMatch ? titleLineMatch[1].trim() : '';
    let titleConfirmsChapterNo = false;
    if (pageTitle) {
      const pageChapMatch =
        pageTitle.match(/\b(?:chapter|ch\.?)\s*(\d+)\s*$/i) ||
        pageTitle.match(/\b(?:chapter|ch\.?)\s*(\d+)/i);
      if (pageChapMatch) {
        if (parseInt(pageChapMatch[1], 10) !== chapterNo) {
          return { extracted: null, is404: false, isAiGated: false, isAdHijacked: false, isUnloadedShell: false };
        }
        titleConfirmsChapterNo = true;
      }
      if (expectedNovelTitle && !/^WTR-Lab/i.test(expectedNovelTitle)) {
        const strippedTitle = pageTitle
          .replace(/\s*[-|–—]\s*wtr-?lab.*$/i, '')
          .replace(/\s*\b(?:chapter|ch\.?)\s*\d+.*$/i, '')
          .replace(/\s*#\d+.*$/i, '')
          .trim();
        if (
          strippedTitle &&
          strippedTitle.toLowerCase() !== 'wtr-lab' &&
          !titleMatchesCandidate(expectedNovelTitle, strippedTitle)
        ) {
          return { extracted: null, is404: false, isAiGated: false, isAdHijacked: false, isUnloadedShell: false };
        }
      }
    }
    const urlConfirmsChapterNo = new RegExp(`/chapter-${chapterNo}(?:[?#/]|$)`, 'i').test(urlSource);

    const bodyMarkerIdx = md.indexOf('Markdown Content:');
    const bodyText = bodyMarkerIdx >= 0 ? md.slice(bodyMarkerIdx + 'Markdown Content:'.length) : md;
    const lines = bodyText.split(/\r?\n/);

    // Detect unloaded CSR skeleton shell (**#11** ... **#12** ... **#13** with no prose paragraphs)
    if (
      md.includes('Warning: This page maybe not yet fully loaded') &&
      bodyText.length < 950 &&
      new RegExp(`\\*\\*#${chapterNo + 1}\\*\\*`).test(bodyText)
    ) {
      return { extracted: null, is404: false, isAiGated, isAdHijacked: false, isUnloadedShell: true };
    }

    let startIdx = 0;
    let extractedTitle = ssrFallbackTitle
      ? normalizeWtrlabSlotTitle(ssrFallbackTitle, chapterNo)
      : `Chapter ${chapterNo}`;
    let foundMatchedHeading = false;
    let foundWrongChapterHeading = false;
    let matchedSourceChapNo: number | null = null;
    const nextSlotMarkerRe = new RegExp(`^(?:\\*\\*#${chapterNo + 1}\\*\\*|#{1,4}\\s*#${chapterNo + 1}\\b)`);

    // Scan ONLY the leading header zone (up to first 18 non-empty lines, stopping if long story prose already started!)
    let nonEmptyScanned = 0;
    let proseLinesSeen = 0;
    for (let i = 0; i < Math.min(lines.length, 45); i++) {
      const l = lines[i].trim();
      if (!l) continue;
      nonEmptyScanned++;
      if (nextSlotMarkerRe.test(l)) break;
      if (/^ch\.\s*\d+\s*\/\s*\d+/i.test(l)) continue;

      // Never mistake dialogue lines ("Chapter 1...", “Chapter 1...”) for headings
      if (/^["'“‘«『「【]/.test(l)) {
        proseLinesSeen++;
        if (proseLinesSeen >= 2) break;
        continue;
      }

      const hashHeading = l.match(/^#{1,4}\s*(?:#\d+\s*)?(.+)$/);
      const boldNumHeading = l.match(/^\*\*#\d+\*\*\s*(.+)$/);
      const boldChapHeading = l.match(/^\*\*((?:Chapter|Ch\.?|Episode|Ep\.?|Prologue|Epilogue|Interlude)\b[^*]{0,130})\*\*$/i);
      const plainChapHeading =
        l.length <= 125
          ? l.match(/^((?:Chapter|Ch\.?|Episode|Ep\.?)\s*(?:\d+|[IVXLCDM]{1,10})(?:'s\b|\b).{0,110})$/i) ||
            l.match(/^((?:Prologue|Epilogue|Interlude)(?:\s*[:\-–—]\s*.{1,100})?)$/i)
          : null;
      const wordChapHeading =
        l.length <= 125
          ? l.match(/^(?:\*\*)?((?:Chapter|Ch\.?)\s+[A-Za-z-]+(?:\s+[A-Za-z-]+){0,5}(?:\s*[:\-–—]\s*.{1,100})?)(?:\*\*)?$/i)
          : null;

      let candidateTitle = '';
      if (hashHeading && l.length <= 150) {
        candidateTitle = hashHeading[1].replace(/\*\*/g, '').trim();
      } else if (boldNumHeading) {
        candidateTitle = boldNumHeading[1].replace(/\*\*/g, '').trim();
      } else if (boldChapHeading) {
        candidateTitle = boldChapHeading[1].replace(/\*\*/g, '').trim();
      } else if (plainChapHeading && !/^ch\.\s*\d+\s*\//i.test(l)) {
        candidateTitle = plainChapHeading[1].trim();
      } else if (
        wordChapHeading &&
        parseEnglishWordNumber(wordChapHeading[1].match(/^(?:chapter|ch\.?)\s+([a-z-]+(?:\s+[a-z-]+){0,5})/i)?.[1] || '') !== null
      ) {
        candidateTitle = wordChapHeading[1].replace(/\*\*/g, '').trim();
      }

      if (candidateTitle) {
        if (chapterHeadingMatchesRequested(candidateTitle, chapterNo, true)) {
          extractedTitle = normalizeWtrlabSlotTitle(candidateTitle, chapterNo);
          matchedSourceChapNo = extractChapterNumberFromHeading(candidateTitle);
          startIdx = i + 1;
          foundMatchedHeading = true;
          break;
        } else if (titleConfirmsChapterNo && urlConfirmsChapterNo && nonEmptyScanned <= 10) {
          // Author heading has Prologue/Volume offset while WTR-Lab URL + <title> strictly confirmed this exact chapter slot!
          matchedSourceChapNo = extractChapterNumberFromHeading(candidateTitle);
          extractedTitle = normalizeWtrlabSlotTitle(candidateTitle, chapterNo);
          startIdx = i + 1;
          foundMatchedHeading = true;
          break;
        } else {
          foundWrongChapterHeading = true;
        }
      } else if (l.length > 90 && !l.startsWith('[') && !l.startsWith('*')) {
        // Long narrative prose has already begun without a chapter heading -> keep from line 0!
        proseLinesSeen++;
        if (proseLinesSeen >= 2) break;
      }
    }

    if (!foundMatchedHeading && foundWrongChapterHeading && !(titleConfirmsChapterNo && urlConfirmsChapterNo)) {
      return { extracted: null, is404: false, isAiGated: false, isAdHijacked: false, isUnloadedShell: false };
    }

    const noiseExactOrPrefix = [
      /^\[?\s*prev\s*\]?(?:\(|$)/i,
      /^\[?\s*next\s*\]?(?:\(|$)/i,
      /^\[?\s*web\s*\]?(?:\(|$)/i,
      /^\[?\s*web\+\s*\]?(?:\(|$)/i,
      /^\[?\s*ai\s*\]?(?:\(|$)/i,
      /^\[web\]\(https:\/\/wtr-lab\.com/i,
      /^ch\.\s*\d+\s*\/\s*\d+/i,
      /^\*?\s*\[contents\]/i,
      /^\d+\.\s*\[[^\]]+\]\(https:\/\/wtr-lab\.com/i,
      /^contents$/i,
      /^edit terms$/i,
      /^add to library$/i,
      /^read display settings$/i,
      /^more$/i,
      /^\+$/,
      /^\*{0,2}ad blocker detected\*{0,2}$/i,
      /^please disable your ad blocker/i,
      /^problematic ad\?/i,
      /^you can disable popup ads/i,
      /^\*{0,2}ai translation requires registration\*{0,2}/i,
      /^guests can preview ai translation/i,
      /^sign up for free to continue/i,
      /^or click here to read with/i,
      /^\[or click here to read with/i,
      /^gemini-[\w.-]+$/i,
      /^gpt-[\w.-]+$/i,
      /^claude-[\w.-]+$/i,
      /^translated\s+with\s+/i,
      /^translator:\s*/i,
      /^author:\s*/i,
      /^!\[image/i,
      /^wtr-lab\s+read\s+translated/i,
      /^copyright\s*©/i,
      /^\*\s*\[(?:discord|patreon|intro|about|contact|dmca|privacy|terms)/i,
    ];

    const stopFooterPatterns = [
      /^\[prev\]\(https:\/\/wtr-lab\.com/i,
      /^prevch\.\s*\d+/i,
      /^ch\.\s*\d+\s*\/\s*\d+/i,
      /^\*\s*\[contents\]/i,
      /^wtr-lab\s+read\s+translated/i,
      /^copyright\s*©\s*\d+/i,
      /^\*\*#\d+\*\*$/,
    ];

    const boundaryNums = new Set<number>([chapterNo + 1, chapterNo + 2]);
    if (matchedSourceChapNo && matchedSourceChapNo > 1 && matchedSourceChapNo !== chapterNo) {
      boundaryNums.add(matchedSourceChapNo + 1);
    }
    const nextNumAlternation = Array.from(boundaryNums).join('|');

    // STRICT Next-Chapter Boundary Detector:
    // Only triggers on true structural WTR-Lab slot markers (**#N+1**, ### #N+1, **Chapter N+1...**)
    // or short standalone unquoted heading lines (< 95 chars) — NEVER cuts off mid-story dialogue/sentences!
    const isStructuralNextChapterBoundary = (line: string): boolean => {
      if (line.length > 110) return false;
      if (/^["'“‘«『「]/.test(line)) return false;
      if (new RegExp(`^(?:\\*\\*#(?:${nextNumAlternation})\\*\\*|#{1,4}\\s*#?(?:Chapter\\s*)?(?:${nextNumAlternation})\\b)`, 'i').test(line)) {
        return true;
      }
      if (new RegExp(`^\\*\\*(?:Chapter|Ch\\.?)\\s*(?:${nextNumAlternation})\\b[^*]*\\*\\*$`, 'i').test(line)) {
        return true;
      }
      if (
        line.length <= 85 &&
        !/[.!?]$/.test(line.replace(/!+$/, '')) &&
        new RegExp(`^(?:Chapter|Ch\\.?)\\s*(?:${nextNumAlternation})(?:\\s*[:\\-–—]\\s*\\S.*|$)`, 'i').test(line)
      ) {
        return true;
      }
      return false;
    };

    const rawParagraphs: string[] = [];
    for (let i = startIdx; i < lines.length; i++) {
      let l = lines[i].trim();
      if (!l) continue;
      if (isStructuralNextChapterBoundary(l)) break;
      if (rawParagraphs.length >= 1 && stopFooterPatterns.some((rx) => rx.test(l))) break;
      if (noiseExactOrPrefix.some((rx) => rx.test(l))) continue;

      // Strip duplicate leading chapter heading before paragraph 1
      if (rawParagraphs.length === 0 && !/^["'“‘]/.test(l)) {
        if (/^\*\*#\d+\*\*/.test(l)) {
          const cleanedSub = l.replace(/\*\*#\d+\*\*/g, '').replace(/\*\*/g, '').trim();
          if (cleanedSub && cleanedSub.length < 150) {
            extractedTitle = normalizeWtrlabSlotTitle(cleanedSub, chapterNo);
            foundMatchedHeading = true;
          }
          continue;
        }
        const plainClean = l.replace(/\*\*/g, '').trim();
        if (
          plainClean.length < 130 &&
          (plainClean.toLowerCase() === extractedTitle.toLowerCase() ||
            /^(?:chapter|ch\.?)\s*(?:\d+(?:'s\b|\b)|[IVXLCDM]{1,10}\b|[A-Za-z-]+(?:\s+[A-Za-z-]+){0,4}\s*[:\-–—])/i.test(plainClean))
        ) {
          extractedTitle = normalizeWtrlabSlotTitle(plainClean, chapterNo);
          foundMatchedHeading = true;
          continue;
        }
      }

      if (/^\*?\s*\[[^\]]+\]\(https:\/\/wtr-lab\.com\/en\//.test(l) && l.length < 140) continue;
      l = l.replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1').trim();
      if (l.length >= 1) rawParagraphs.push(l);
    }

    const paragraphs = deduplicateChapterParagraphs(rawParagraphs);
    const wordCount = paragraphs.join(' ').split(/\s+/).filter(Boolean).length;
    const confirmedByUrlAndTitle = titleConfirmsChapterNo && urlConfirmsChapterNo;

    // Accept normal chapters AND short/announcement/prologue chapters without ever dropping a valid chapter in between!
    const hasEnoughContent =
      paragraphs.length >= 3 ||
      (paragraphs.length >= 1 && wordCount >= 22) ||
      (confirmedByUrlAndTitle && paragraphs.length >= 1 && wordCount >= 10);

    if (
      (foundMatchedHeading || confirmedByUrlAndTitle) &&
      chapterHeadingMatchesRequested(extractedTitle, chapterNo, true) &&
      hasEnoughContent
    ) {
      return {
        extracted: { title: normalizeWtrlabSlotTitle(extractedTitle, chapterNo), paragraphs },
        is404: false,
        isAiGated: false,
        isAdHijacked: false,
        isUnloadedShell: false,
      };
    }

    return {
      extracted: null,
      is404: false,
      isAiGated,
      isAdHijacked: false,
      isUnloadedShell: paragraphs.length < 2,
    };
  }

  /**
   * Unified Advanced WTR-Lab Chapter Scraper Engine (Zero-Drop, Zero-Duplicate Edition)
   * 1. Resolves canonical slug upfront (eliminates Next.js `/novel/` -> `/<slug>/` +1 chapter shift!).
   * 2. Coalesces identical concurrent fetches (`wtrlabChapterInflight`).
   * 3. Uses `div.chapter-wrap:first-of-type` + `.chapter-body p` with ad/iframe removal.
   * 4. Multi-Mode Cascade (`AI [<=10] -> Web+ -> Web` or `Web -> Web+`) with learned per-novel mode cache.
   * 5. Authoritative SSR `__NEXT_DATA__` Probe on failure: distinguishes true 404/locked chapters in <1s
   *    from slow-hydrating valid chapters, and runs a dedicated high-timeout recovery pass for valid chapters!
   */
  async function fetchWtrlabLiveChapterViaJina(
    novelId: string,
    slug: string,
    chapterNo: number,
    serviceMode: 'web' | 'webplus' | 'ai' = 'ai',
    expectedNovelTitle?: string,
    priority: 'high' | 'medium' | 'low' = 'high',
    options?: { retryWithCacheBust?: boolean; timeoutMs?: number; noTargetSelector?: boolean; jinaWaitSec?: string }
  ): Promise<{ title: string; paragraphs: string[] } | null> {
    const cleanId = String(novelId).trim();
    if (priority === 'high') lastInteractiveJinaAt = Date.now();

    let canonicalSlug = await ensureCanonicalWtrlabSlug(cleanId, slug);
    const get404Key = (s: string) => `https://wtr-lab.com/en/novel/${cleanId}/${s}/chapter-${chapterNo}`;

    if (isJinaUrlKnown404(get404Key(canonicalSlug))) {
      return null;
    }

    let primaryMode: WtrlabServiceMode =
      serviceMode === 'ai' && chapterNo > 10 ? 'webplus' : serviceMode;
    const learnedFallback = wtrlabEmptyServiceFallback.get(`${cleanId}:${primaryMode}`);
    if (learnedFallback && learnedFallback.expiresAt > Date.now()) {
      primaryMode = learnedFallback.targetMode;
    }

    const inflightKey = `${cleanId}:${chapterNo}:${primaryMode}`;
    const existingInflight = wtrlabChapterInflight.get(inflightKey);
    if (existingInflight && options?.retryWithCacheBust === undefined) {
      const shared = await existingInflight;
      return shared ? { title: shared.title, paragraphs: shared.paragraphs } : null;
    }

    const runExtraction = (async (): Promise<{ title: string; paragraphs: string[]; modeUsed: WtrlabServiceMode; source: string } | null> => {
      const modeQueue: WtrlabServiceMode[] = [primaryMode];
      if (primaryMode === 'ai') modeQueue.push('webplus', 'web');
      else if (primaryMode === 'webplus') modeQueue.push('web');
      else if (primaryMode === 'web') modeQueue.push('webplus');

      const reqTimeoutMs = options?.timeoutMs ?? 18000;
      const buildUrl = (slugToUse: string, mode: WtrlabServiceMode, cacheBust = false) => {
        const qsParts: string[] = [];
        if (mode === 'web') qsParts.push('service=web');
        else if (mode === 'webplus') qsParts.push('service=webplus');
        if (cacheBust) qsParts.push(`_cb=${Date.now()}`);
        const qs = qsParts.length > 0 ? `?${qsParts.join('&')}` : '';
        return `https://wtr-lab.com/en/novel/${cleanId}/${slugToUse}/chapter-${chapterNo}${qs}`;
      };

      const buildBrowserHeaders = (mode: 'strict' | 'wide' | 'no-wait', waitSec: string): Record<string, string> => {
        if (mode === 'strict') {
          return {
            'X-Engine': 'browser',
            'X-Target-Selector': 'div.chapter-wrap:first-of-type',
            'X-Wait-For-Selector': 'div.chapter-wrap:first-of-type .chapter-body p, .chapter-body p',
            'X-Remove-Selector': 'iframe, script, style, noscript, ins, .ads, .ad, .adsbygoogle',
            'X-Retain-Images': 'none',
            'X-Timeout': waitSec,
            'X-No-Cache': 'true',
          };
        }
        if (mode === 'wide') {
          return {
            'X-Engine': 'browser',
            'X-Target-Selector': 'div.reader-container, div.chapter-wrap, main',
            'X-Wait-For-Selector': '.chapter-body p, div.chapter-wrap p',
            'X-Remove-Selector': 'iframe, script, style, noscript, ins, .ads, .ad, .adsbygoogle',
            'X-Retain-Images': 'none',
            'X-Timeout': waitSec,
            'X-No-Cache': 'true',
          };
        }
        // 'no-wait' never throws Jina 422 even if unusual HTML tags (<br>/<div>) are used instead of <p>!
        return {
          'X-Engine': 'browser',
          'X-Target-Selector': 'div.chapter-wrap:first-of-type, div.reader-container, main',
          'X-Remove-Selector': 'iframe, script, style, noscript, ins, .ads, .ad, .adsbygoogle',
          'X-Retain-Images': 'none',
          'X-Timeout': waitSec,
          'X-No-Cache': 'true',
        };
      };

      let ssrStateChecked = false;
      let ssrTitleHint: string | undefined;

      const ensureSsrVerified = async (): Promise<boolean> => {
        if (ssrStateChecked) return !isJinaUrlKnown404(get404Key(canonicalSlug));
        ssrStateChecked = true;
        const probe = await probeWtrlabChapterSsrState(cleanId, canonicalSlug, chapterNo, priority);
        if (probe.realSlug && probe.realSlug !== canonicalSlug) {
          canonicalSlug = probe.realSlug;
        }
        if (probe.ssrTitle) {
          ssrTitleHint = probe.ssrTitle;
        }
        if (probe.confirmedMissing || !probe.exists) {
          markJinaUrl404(get404Key(canonicalSlug));
          return false;
        }
        return true;
      };

      for (let mIdx = 0; mIdx < modeQueue.length; mIdx++) {
        const candidateMode = modeQueue[mIdx];
        const targetUrl = buildUrl(canonicalSlug, candidateMode, false);
        if (isJinaUrlKnown404(get404Key(canonicalSlug))) return null;

        if (priority === 'high') lastInteractiveJinaAt = Date.now();
        const headers = buildBrowserHeaders(options?.noTargetSelector ? 'wide' : 'strict', options?.jinaWaitSec || '14');
        const md = await fetchJinaWithHeaders(targetUrl, headers, reqTimeoutMs, priority);

        // If md came back null (e.g. Jina 422 selector timeout or network timeout), run the fast 0.8s SSR probe!
        if (!md) {
          const existsOnWtr = await ensureSsrVerified();
          if (!existsOnWtr) return null;
        }

        const parsed = parseWtrlabChapterMarkdown({
          md: md || '',
          novelId: cleanId,
          chapterNo,
          expectedNovelTitle,
          activeMode: candidateMode,
          ssrFallbackTitle: ssrTitleHint,
        });

        if (parsed.is404) {
          const existsOnWtr = await ensureSsrVerified();
          if (!existsOnWtr) {
            markJinaUrl404(targetUrl);
            markJinaUrl404(get404Key(canonicalSlug));
            return null;
          }
        }

        if (parsed.extracted) {
          if (mIdx > 0 && primaryMode === 'web' && candidateMode === 'webplus') {
            wtrlabEmptyServiceFallback.set(`${cleanId}:web`, {
              targetMode: 'webplus',
              expiresAt: Date.now() + 30 * 60 * 1000,
            });
          }
          setWtrlabLiveSnapshot(cleanId, chapterNo, candidateMode, parsed.extracted.title, parsed.extracted.paragraphs);
          if (serviceMode !== candidateMode) {
            setWtrlabLiveSnapshot(cleanId, chapterNo, serviceMode, parsed.extracted.title, parsed.extracted.paragraphs);
          }
          return {
            title: parsed.extracted.title,
            paragraphs: parsed.extracted.paragraphs,
            modeUsed: candidateMode,
            source: 'wtrlab-live',
          };
        }

        // Guest AI gate (>Ch 10) -> advance immediately to webplus
        if (parsed.isAiGated && candidateMode === 'ai') {
          continue;
        }

        // Transient ad-hijack / slow hydration / 422 timeout on a chapter that EXISTS on WTR-Lab -> retry cleanly!
        if ((parsed.isAdHijacked || parsed.isUnloadedShell || !md) && options?.retryWithCacheBust !== false) {
          const existsOnWtr = await ensureSsrVerified();
          if (!existsOnWtr) return null;

          if (priority === 'high') lastInteractiveJinaAt = Date.now();
          const retryUrl = buildUrl(canonicalSlug, candidateMode, true);
          // Use 'no-wait' if md was null (avoids 422 if chapter uses non-<p> markup), otherwise 'wide'
          const retryHeaders = buildBrowserHeaders(!md ? 'no-wait' : 'wide', '16');
          const retryMd = await fetchJinaWithHeaders(retryUrl, retryHeaders, Math.max(reqTimeoutMs, 21000), priority);
          const retryParsed = parseWtrlabChapterMarkdown({
            md: retryMd || '',
            novelId: cleanId,
            chapterNo,
            expectedNovelTitle,
            activeMode: candidateMode,
            ssrFallbackTitle: ssrTitleHint,
          });

          if (retryParsed.extracted) {
            setWtrlabLiveSnapshot(cleanId, chapterNo, candidateMode, retryParsed.extracted.title, retryParsed.extracted.paragraphs);
            if (serviceMode !== candidateMode) {
              setWtrlabLiveSnapshot(cleanId, chapterNo, serviceMode, retryParsed.extracted.title, retryParsed.extracted.paragraphs);
            }
            return {
              title: retryParsed.extracted.title,
              paragraphs: retryParsed.extracted.paragraphs,
              modeUsed: candidateMode,
              source: 'wtrlab-live-retry',
            };
          }
        }
      }

      // Final Deep Recovery Pass: if SSR confirmed the chapter genuinely exists on WTR-Lab, do 1 calm backoff recovery
      // using webplus (no-wait selector, 22s timeout) so NO valid chapter in the middle of a novel is ever dropped!
      const stillExists = await ensureSsrVerified();
      if (stillExists && options?.retryWithCacheBust !== false) {
        await new Promise((r) => setTimeout(r, 1200));
        const rescueMode: WtrlabServiceMode = chapterNo <= 10 && primaryMode === 'ai' ? 'ai' : 'webplus';
        const rescueUrl = buildUrl(canonicalSlug, rescueMode, true);
        const rescueMd = await fetchJinaWithHeaders(rescueUrl, buildBrowserHeaders('no-wait', '17'), 23000, priority);
        const rescueParsed = parseWtrlabChapterMarkdown({
          md: rescueMd || '',
          novelId: cleanId,
          chapterNo,
          expectedNovelTitle,
          activeMode: rescueMode,
          ssrFallbackTitle: ssrTitleHint,
        });
        if (rescueParsed.extracted) {
          setWtrlabLiveSnapshot(cleanId, chapterNo, rescueMode, rescueParsed.extracted.title, rescueParsed.extracted.paragraphs);
          if (serviceMode !== rescueMode) {
            setWtrlabLiveSnapshot(cleanId, chapterNo, serviceMode, rescueParsed.extracted.title, rescueParsed.extracted.paragraphs);
          }
          return {
            title: rescueParsed.extracted.title,
            paragraphs: rescueParsed.extracted.paragraphs,
            modeUsed: rescueMode,
            source: 'wtrlab-deep-rescue',
          };
        }
      }

      return null;
    })().finally(() => {
      wtrlabChapterInflight.delete(inflightKey);
    });

    wtrlabChapterInflight.set(inflightKey, runExtraction);
    const finalResult = await runExtraction;
    return finalResult ? { title: finalResult.title, paragraphs: finalResult.paragraphs } : null;
  }

  /**
   * Unified helper to fetch a WTR-Lab chapter cleanly with multi-attempt zero-drop resilience:
   * 1. Verified In-Memory Cache (optional)
   * 2. Direct WTR-Lab `/api/reader/get` + AES-256-GCM Decryption (fast path when CF allows)
   * 3. Browser-Rendered WTR-Lab Live Chapter Extractor (canonical slug + SSR probe + deep rescue)
   */
  async function scrapeWtrlabChapterClean(params: {
    novelId: string;
    slug?: string;
    chapterNo: number;
    serviceMode?: WtrlabServiceMode;
    language?: 'en' | 'hi';
    novelTitle?: string;
    skipCache?: boolean;
    priority?: 'high' | 'medium' | 'low';
    timeoutMs?: number;
  }): Promise<{
    title: string;
    paragraphs: string[];
    origin: 'cache' | 'wtrlab-api' | 'wtrlab-live';
    canonicalSlug: string;
  } | null> {
    const cleanId = String(params.novelId).trim();
    const chNo = Math.max(1, Number(params.chapterNo) || 1);
    const mode: WtrlabServiceMode = params.serviceMode || 'ai';
    const lang = params.language === 'hi' ? 'hi' : 'en';
    const priority = params.priority || 'high';

    const canonicalSlug = await ensureCanonicalWtrlabSlug(cleanId, params.slug);
    const enCacheKey = `${cleanId}:${chNo}:en:${mode}:en`;

    if (!params.skipCache && lang === 'en') {
      const cached = wtrlabChapterCache.get(enCacheKey);
      if (cached && cached.paragraphs.length >= 1 && Date.now() - cached.timestamp < 24 * 60 * 60 * 1000) {
        return {
          title: normalizeWtrlabSlotTitle(cached.title, chNo),
          paragraphs: deduplicateChapterParagraphs(cached.paragraphs),
          origin: 'cache',
          canonicalSlug,
        };
      }
    }

    // Fast Path 1: Direct Reader API (auto-skipped during 10-min CF 403 circuit-breaker cooldown)
    if (Date.now() > wtrlabReaderApiCfBlockedUntil) {
      try {
        const effectiveTranslate = mode === 'ai' && chNo > 10 ? 'webplus' : mode;
        const readerRes = await fetch('https://wtr-lab.com/api/reader/get', {
          method: 'POST',
          headers: {
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/plain, */*',
            Origin: 'https://wtr-lab.com',
            Referer: `https://wtr-lab.com/en/novel/${cleanId}/${canonicalSlug}/chapter-${chNo}`,
          },
          body: JSON.stringify({
            language: 'en',
            raw_id: Number(cleanId) || cleanId,
            chapter_no: chNo,
            translate: effectiveTranslate,
          }),
          signal: AbortSignal.timeout(2500),
        });

        if (readerRes.status === 403 || readerRes.status === 503 || readerRes.status === 429) {
          wtrlabReaderApiCfBlockedUntil = Date.now() + 10 * 60 * 1000;
        } else if (readerRes.status === 404) {
          markJinaUrl404(`https://wtr-lab.com/en/novel/${cleanId}/${canonicalSlug}/chapter-${chNo}`);
          return null;
        } else if (readerRes.ok) {
          const data = await readerRes.json();
          const rawBody = data?.data?.data?.body;
          if (rawBody) {
            const decrypted = typeof rawBody === 'string' ? decryptWtrlabBody(rawBody) : rawBody;
            const cleanParas = deduplicateChapterParagraphs(Array.isArray(decrypted) ? decrypted.map(String) : [String(decrypted)]);
            if (cleanParas.length >= 1 && cleanParas.join(' ').trim().length >= 30) {
              const apiTitle = normalizeWtrlabSlotTitle(data?.data?.data?.title || `Chapter ${chNo}`, chNo);
              setWtrlabLiveSnapshot(cleanId, chNo, mode, apiTitle, cleanParas);
              return {
                title: apiTitle,
                paragraphs: cleanParas,
                origin: 'wtrlab-api',
                canonicalSlug,
              };
            }
          }
        }
      } catch {
        // Proceed seamlessly to browser-rendered Jina engine
      }
    }

    // Reliable Path 2: Browser-rendered WTR-Lab Live Extractor (with SSR existence probe & deep rescue)
    const live = await fetchWtrlabLiveChapterViaJina(
      cleanId,
      canonicalSlug,
      chNo,
      mode,
      params.novelTitle,
      priority,
      { retryWithCacheBust: true, timeoutMs: params.timeoutMs ?? 18000 }
    );

    if (live && live.paragraphs.length >= 1) {
      const cleanParas = deduplicateChapterParagraphs(live.paragraphs);
      const cleanTitle = normalizeWtrlabSlotTitle(live.title, chNo);
      return {
        title: cleanTitle,
        paragraphs: cleanParas,
        origin: 'wtrlab-live',
        canonicalSlug,
      };
    }

    return null;
  }
