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

  // Per-novel canonical slug registry — CRITICAL to prevent wtr-lab.com SPA chapter-shift bugs!
  const wtrlabResolvedSlugCache = new Map<string, string>();
  const wtrlabSlugInflight = new Map<string, Promise<string>>();

  // In-flight single-flight deduplicator for identical chapter fetches
  const wtrlabChapterInflight = new Map<string, Promise<{ title: string; paragraphs: string[]; modeUsed: WtrlabServiceMode; source: string } | null>>();

  // Known HTTP 404 / 422 (out-of-range chapter) circuit breaker
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

  function markJinaUrl404(rawUrl: string, ttlMs = 10 * 60 * 1000) {
    const base = normalizeJinaBaseUrl(rawUrl);
    if (!base) return;
    if (jinaKnown404Until.size >= 2000) {
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
    if (!title || !Array.isArray(paragraphs) || paragraphs.length < 2) return;
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
    if (words.length === 0 || words.length > 6) return null;
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

  function extractChapterNumberFromHeading(heading: string): number | null {
    if (!heading) return null;
    const m =
      heading.match(/(?:chapter|ch\.?|episode|ep\.?)\s*(\d+)/i) ||
      heading.match(/^#(\d+)\b/) ||
      heading.match(/^(\d+)\s*[:.\-–—]\s*\S/);
    if (m) {
      const parsed = parseInt(m[1], 10);
      if (!isNaN(parsed)) return parsed;
    }
    const wordMatch = heading.match(/^(?:\*\*)?(?:chapter|ch\.?)\s+([a-z-]+(?:\s+[a-z-]+){0,4})(?:\s*[:\-–—.,;]|$)/i);
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
      const wordSub = clean.match(/^(?:Chapter|Ch\.?)\s+[A-Za-z-]+(?:\s+[A-Za-z-]+){0,4}\s*[:\-–—.,;]\s*(.+)$/i);
      if (wordSub) {
        subtitle = (wordSub[1] || '').replace(/^[:\-–—.,;\s]+/, '').trim();
      } else if (!/^(?:chapter|ch\.?)\s*\d+$/i.test(clean) && clean.length >= 2 && clean.length <= 120) {
        // Pure author title without "Chapter N" prefix (e.g., "Final elbow strike" or "Prologue: Awakening")
        subtitle = clean;
      }
    }
    return subtitle && subtitle.length >= 2 ? `Chapter ${slotNo}: ${subtitle}` : `Chapter ${slotNo}`;
  }

  /**
   * Computes robust content fingerprint for chapter deduplication across an entire novel build.
   * Combines opening, middle, and closing normalized prose slices so neither leaked adjacent chapters
   * nor duplicate fetches can ever slip past.
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
    const fullHash = joined.replace(/\|/g, '').length >= 45
      ? crypto.createHash('sha1').update(joined).digest('hex').slice(0, 20)
      : '';
    return { fullHash, openingKey, secondKey };
  }

  /**
   * Deduplicates intra-chapter repeated paragraph runs (e.g. if WTR-Lab Hydration/CSR rendered
   * the chapter body twice or repeated trailing paragraphs) while preserving natural dialogue/SFX.
   */
  function deduplicateChapterParagraphs(paragraphs: string[]): string[] {
    if (!Array.isArray(paragraphs) || paragraphs.length <= 1) return paragraphs || [];

    const normLine = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9\u0900-\u097f]+/g, ' ').trim();

    // 1. Check if the entire second half of the array is an exact repeat of the first half (SSR/CSR double mount)
    if (paragraphs.length >= 8 && paragraphs.length % 2 === 0) {
      const half = paragraphs.length / 2;
      let matches = 0;
      for (let i = 0; i < half; i++) {
        if (normLine(paragraphs[i]) === normLine(paragraphs[half + i])) matches++;
      }
      if (matches / half >= 0.85) {
        paragraphs = paragraphs.slice(0, half);
      }
    }

    // 2. Remove consecutive identical paragraphs and repeated long prose blocks (>55 normalized chars)
    const out: string[] = [];
    const seenLongBlocks = new Set<string>();
    let prevNorm = '';

    for (const rawP of paragraphs) {
      const trimmed = String(rawP || '').trim();
      if (!trimmed) continue;
      const n = normLine(trimmed);
      if (!n) continue;

      // Never repeat back-to-back identical lines
      if (n === prevNorm && n.length >= 12) continue;

      // Long narrative paragraphs (>55 chars) should not repeat verbatim within the same chapter
      if (n.length >= 55) {
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
   * CRITICAL: Requesting `/en/novel/{id}/novel/chapter-{N}` with a placeholder slug causes WTR-Lab's
   * Next.js router to client-redirect to the real slug and advance/shift the chapter by +1!
   * Resolving the real slug once guarantees 100% exact chapter alignment.
   */
  async function ensureCanonicalWtrlabSlug(novelId: string, slugHint?: string): Promise<string> {
    const cleanId = String(novelId || '').trim();
    const cleanHint = String(slugHint || '')
      .trim()
      .replace(/^\/+|\/+$/g, '');

    // Valid real slug already known (not generic placeholder like 'novel' or 'novel-123')
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
        // Lightweight fallback: SSR HTML fetch of chapter-1 extracts real slug from __NEXT_DATA__ in ~0.8s
        const ssrHtml = await fetchWtrlabHtmlViaJina(`https://wtr-lab.com/en/novel/${cleanId}/novel/chapter-1`, 9000, 'high');
        if (ssrHtml) {
          const ndMatch = ssrHtml.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
          if (ndMatch) {
            const parsed = JSON.parse(ndMatch[1]);
            const realSlug =
              parsed?.props?.pageProps?.serie?.serie_data?.slug ||
              parsed?.props?.pageProps?.serie?.chapter?.slug;
            if (realSlug && !isGenericSlug(realSlug)) {
              wtrlabResolvedSlugCache.set(cleanId, realSlug);
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
   * Parses WTR-Lab browser-rendered Markdown into clean { title, paragraphs }
   * with strict chapter-slot verification, preloaded-slot cutoff, UI/ad noise stripping,
   * and intra-chapter deduplication.
   */
  function parseWtrlabChapterMarkdown(params: {
    md: string;
    novelId: string;
    chapterNo: number;
    expectedNovelTitle?: string;
    activeMode: WtrlabServiceMode;
  }): {
    extracted: { title: string; paragraphs: string[] } | null;
    is404: boolean;
    isAiGated: boolean;
    isAdHijacked: boolean;
    isUnloadedShell: boolean;
  } {
    const { md, novelId, chapterNo, expectedNovelTitle, activeMode } = params;
    if (!md) {
      return { extracted: null, is404: false, isAiGated: false, isAdHijacked: false, isUnloadedShell: true };
    }

    const head = md.slice(0, 900);
    const is404 =
      md.includes('Warning: Target URL returned error 404') ||
      md.includes('Warning: Target URL returned error 422') ||
      /\b(?:404|422)\b[\s:-]*(?:page not found|unprocessable)/i.test(head) ||
      /^Title:\s*.*(?:404|Page Not Found)/im.test(head) ||
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

    if (md.length < 380) {
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
      const pageChapMatch = pageTitle.match(/(?:chapter|ch\.?)\s*(\d+)\s*$/i) || pageTitle.match(/(?:chapter|ch\.?)\s*(\d+)/i);
      if (pageChapMatch) {
        if (parseInt(pageChapMatch[1], 10) !== chapterNo) {
          return { extracted: null, is404: false, isAiGated: false, isAdHijacked: false, isUnloadedShell: false };
        }
        titleConfirmsChapterNo = true;
      }
      if (expectedNovelTitle && !/^WTR-Lab/i.test(expectedNovelTitle)) {
        const strippedTitle = pageTitle
          .replace(/\s*[-|–—]\s*wtr-?lab.*$/i, '')
          .replace(/\s*(?:chapter|ch\.?)\s*\d+.*$/i, '')
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
    let extractedTitle = `Chapter ${chapterNo}`;
    let foundMatchedHeading = false;
    let foundWrongChapterHeading = false;
    let matchedSourceChapNo: number | null = null;
    const nextSlotMarkerRe = new RegExp(`^(?:\\*\\*#${chapterNo + 1}\\*\\*|#{1,4}\\s*#${chapterNo + 1}\\b)`);

    for (let i = 0; i < Math.min(lines.length, 55); i++) {
      const l = lines[i].trim();
      if (!l) continue;
      if (nextSlotMarkerRe.test(l)) break;
      if (/^ch\.\s*\d+\s*\/\s*\d+/i.test(l)) continue;

      const hashHeading = l.match(/^#{1,4}\s*(?:#\d+\s*)?(.+)$/);
      const boldNumHeading = l.match(/^\*\*#\d+\*\*\s*(.+)$/);
      const boldChapHeading = l.match(/^\*\*((?:Chapter|Ch\.?|Episode|Ep\.?)\s*\d+[^*]*)\*\*$/i);
      const plainChapHeading = l.match(/^((?:Chapter|Ch\.?|Episode|Ep\.?)\s*\d+(?:'s\b|\b).{0,140})$/i);
      const wordChapHeading = l.match(/^(?:\*\*)?((?:Chapter|Ch\.?)\s+[A-Za-z-]+(?:\s+[A-Za-z-]+){0,4}\s*[:\-–—]?\s*.{0,120})(?:\*\*)?$/i);

      let candidateTitle = '';
      if (hashHeading && (/#\d+/.test(l) || /chapter\s+/i.test(l))) {
        candidateTitle = hashHeading[1].replace(/\*\*/g, '').trim();
      } else if (boldNumHeading) {
        candidateTitle = boldNumHeading[1].replace(/\*\*/g, '').trim();
      } else if (boldChapHeading) {
        candidateTitle = boldChapHeading[1].replace(/\*\*/g, '').trim();
      } else if (plainChapHeading && !/^ch\.\s*\d+\s*\//i.test(l)) {
        candidateTitle = plainChapHeading[1].trim();
      } else if (wordChapHeading && parseEnglishWordNumber((wordChapHeading[1].match(/^(?:chapter|ch\.?)\s+([a-z-]+(?:\s+[a-z-]+){0,4})/i)?.[1] || '')) !== null) {
        candidateTitle = wordChapHeading[1].replace(/\*\*/g, '').trim();
      }

      if (candidateTitle) {
        if (chapterHeadingMatchesRequested(candidateTitle, chapterNo, true)) {
          extractedTitle = normalizeWtrlabSlotTitle(candidateTitle, chapterNo);
          matchedSourceChapNo = extractChapterNumberFromHeading(candidateTitle);
          startIdx = i + 1;
          foundMatchedHeading = true;
          break;
        } else if (titleConfirmsChapterNo && urlConfirmsChapterNo && i <= 12) {
          // Author heading uses prologue offset or non-numbered subtitle, while URL + <title> confirmed exact slot
          matchedSourceChapNo = extractChapterNumberFromHeading(candidateTitle);
          extractedTitle = normalizeWtrlabSlotTitle(candidateTitle, chapterNo);
          startIdx = i + 1;
          foundMatchedHeading = true;
          break;
        } else {
          foundWrongChapterHeading = true;
        }
      }
    }

    if (!foundMatchedHeading && foundWrongChapterHeading) {
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
      boundaryNums.add(matchedSourceChapNo - 1);
    }
    const nextNumAlternation = Array.from(boundaryNums).join('|');
    const nextChapterBoundaryRe = new RegExp(
      `^(?:\\*\\*#(?:${nextNumAlternation})\\*\\*|#{1,4}\\s*#(?:${nextNumAlternation})\\b|(?:\\*\\*)?(?:Chapter|Ch\\.?)\\s*(?:${nextNumAlternation})\\b)`,
      'i'
    );

    const rawParagraphs: string[] = [];
    for (let i = startIdx; i < lines.length; i++) {
      let l = lines[i].trim();
      if (!l) continue;
      if (nextChapterBoundaryRe.test(l)) break;
      if (rawParagraphs.length >= 2 && stopFooterPatterns.some((rx) => rx.test(l))) break;
      if (noiseExactOrPrefix.some((rx) => rx.test(l))) continue;

      // Strip duplicate leading chapter heading before paragraph 1
      if (rawParagraphs.length === 0) {
        if (/^\*\*#\d+\*\*/.test(l)) {
          const cleanedSub = l.replace(/\*\*#\d+\*\*/g, '').replace(/\*\*/g, '').trim();
          if (cleanedSub && cleanedSub.length < 160) {
            extractedTitle = normalizeWtrlabSlotTitle(cleanedSub, chapterNo);
            foundMatchedHeading = true;
          }
          continue;
        }
        const plainClean = l.replace(/\*\*/g, '').trim();
        if (
          plainClean.length < 160 &&
          (plainClean.toLowerCase() === extractedTitle.toLowerCase() ||
            /^(?:chapter|ch\.?)\s*(?:\d+(?:'s\b|\b)|[A-Za-z-]+(?:\s+[A-Za-z-]+){0,3}\s*[:\-–—])/i.test(plainClean))
        ) {
          extractedTitle = normalizeWtrlabSlotTitle(plainClean, chapterNo);
          foundMatchedHeading = true;
          continue;
        }
      }

      if (/^\*?\s*\[[^\]]+\]\(https:\/\/wtr-lab\.com\/en\//.test(l) && l.length < 140) continue;
      l = l.replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1').trim();
      if (l.length >= 2) rawParagraphs.push(l);
    }

    const paragraphs = deduplicateChapterParagraphs(rawParagraphs);
    const wordCount = paragraphs.join(' ').split(/\s+/).filter(Boolean).length;

    if (
      (foundMatchedHeading || titleConfirmsChapterNo) &&
      chapterHeadingMatchesRequested(extractedTitle, chapterNo, true) &&
      (paragraphs.length >= 4 || (paragraphs.length >= 2 && wordCount >= 35))
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
   * Unified Advanced WTR-Lab Chapter Scraper Engine
   * - Resolves canonical slug BEFORE fetching (eliminates /novel/ -> /real-slug/ +1 chapter shift duplicates!)
   * - Single-flight request coalescing (eliminates duplicate concurrent requests for the same chapter)
   * - Scoped strictly to `div.chapter-wrap:first-of-type` + `.chapter-body p` with ad/iframe removal
   * - Automatic service-mode cascade: AI (<=Ch 10) -> Web+ -> Web with learned per-novel mode fallback
   * - Clean resilient retry on transient CSR hydration lag or ad-tracker redirects
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

    // 1. Always resolve real WTR-Lab slug first to prevent Next.js slug-redirect chapter shift!
    const canonicalSlug = await ensureCanonicalWtrlabSlug(cleanId, slug);
    const novelChapter404Key = `https://wtr-lab.com/en/novel/${cleanId}/${canonicalSlug}/chapter-${chapterNo}`;
    if (isJinaUrlKnown404(novelChapter404Key)) {
      return null;
    }

    // 2. Determine optimal mode cascade (WTR-Lab gates guest AI strictly after Chapter 10)
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
      // Build ordered candidate mode cascade without duplicates
      const modeQueue: WtrlabServiceMode[] = [primaryMode];
      if (primaryMode === 'ai') {
        modeQueue.push('webplus', 'web');
      } else if (primaryMode === 'webplus') {
        modeQueue.push('web');
      } else if (primaryMode === 'web') {
        modeQueue.push('webplus');
      }

      const reqTimeoutMs = options?.timeoutMs ?? 17000;
      const buildUrl = (mode: WtrlabServiceMode, cacheBust = false) => {
        // Never append ?service=ai because WTR-Lab defaults to AI and explicit ?service=ai triggers ad redirects
        const qsParts: string[] = [];
        if (mode === 'web') qsParts.push('service=web');
        else if (mode === 'webplus') qsParts.push('service=webplus');
        if (cacheBust) qsParts.push(`_cb=${Date.now()}`);
        const qs = qsParts.length > 0 ? `?${qsParts.join('&')}` : '';
        return `https://wtr-lab.com/en/novel/${cleanId}/${canonicalSlug}/chapter-${chapterNo}${qs}`;
      };

      const buildBrowserHeaders = (useFirstWrapOnly: boolean, waitSec: string): Record<string, string> =>
        useFirstWrapOnly
          ? {
              'X-Engine': 'browser',
              'X-Target-Selector': 'div.chapter-wrap:first-of-type',
              'X-Wait-For-Selector': 'div.chapter-wrap:first-of-type .chapter-body p, .chapter-body p',
              'X-Remove-Selector': 'iframe, script, style, noscript, ins, .ads, .ad, .adsbygoogle',
              'X-Retain-Images': 'none',
              'X-Timeout': waitSec,
              'X-No-Cache': 'true',
            }
          : {
              'X-Engine': 'browser',
              'X-Target-Selector': 'div.reader-container, div.chapter-wrap, main',
              'X-Wait-For-Selector': '.chapter-body p, div.chapter-wrap p',
              'X-Remove-Selector': 'iframe, script, style, noscript, ins, .ads, .ad, .adsbygoogle',
              'X-Retain-Images': 'none',
              'X-Timeout': waitSec,
              'X-No-Cache': 'true',
            };

      for (let mIdx = 0; mIdx < modeQueue.length; mIdx++) {
        const candidateMode = modeQueue[mIdx];
        const targetUrl = buildUrl(candidateMode, false);
        if (isJinaUrlKnown404(targetUrl) || isJinaUrlKnown404(novelChapter404Key)) {
          return null;
        }

        if (priority === 'high') lastInteractiveJinaAt = Date.now();
        const headers = buildBrowserHeaders(!options?.noTargetSelector, options?.jinaWaitSec || '14');
        const md = await fetchJinaWithHeaders(targetUrl, headers, reqTimeoutMs, priority);

        if (isJinaUrlKnown404(targetUrl)) {
          markJinaUrl404(novelChapter404Key);
          return null;
        }

        const parsed = parseWtrlabChapterMarkdown({
          md: md || '',
          novelId: cleanId,
          chapterNo,
          expectedNovelTitle,
          activeMode: candidateMode,
        });

        if (parsed.is404) {
          markJinaUrl404(targetUrl);
          markJinaUrl404(novelChapter404Key);
          return null;
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

        // If AI mode hit guest registration gate (>Ch 10), immediately advance to next mode (webplus) without retrying AI
        if (parsed.isAiGated && candidateMode === 'ai') {
          continue;
        }

        // If transient ad-hijack or CSR hydration timeout occurred on this mode, perform 1 immediate cache-busted retry with wider selector
        if (
          (parsed.isAdHijacked || parsed.isUnloadedShell) &&
          options?.retryWithCacheBust !== false
        ) {
          if (priority === 'high') lastInteractiveJinaAt = Date.now();
          const retryUrl = buildUrl(candidateMode, true);
          const retryHeaders = buildBrowserHeaders(false, '15');
          const retryMd = await fetchJinaWithHeaders(retryUrl, retryHeaders, Math.max(reqTimeoutMs, 19000), priority);
          const retryParsed = parseWtrlabChapterMarkdown({
            md: retryMd || '',
            novelId: cleanId,
            chapterNo,
            expectedNovelTitle,
            activeMode: candidateMode,
          });
          if (retryParsed.is404) {
            markJinaUrl404(novelChapter404Key);
            return null;
          }
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

      return null;
    })().finally(() => {
      wtrlabChapterInflight.delete(inflightKey);
    });

    wtrlabChapterInflight.set(inflightKey, runExtraction);
    const finalResult = await runExtraction;
    return finalResult ? { title: finalResult.title, paragraphs: finalResult.paragraphs } : null;
  }

  /**
   * Unified helper to fetch a WTR-Lab chapter cleanly via:
   * 1. Verified In-Memory Cache (optional)
   * 2. Direct WTR-Lab /api/reader/get + AES-256-GCM Decryption (fast path when CF allows)
   * 3. Browser-Rendered WTR-Lab Live Chapter Extractor (canonical slug + mode cascade + dedup)
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
      if (cached && cached.paragraphs.length >= 2 && Date.now() - cached.timestamp < 24 * 60 * 60 * 1000) {
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
        } else if (readerRes.status === 404 || readerRes.status === 422) {
          markJinaUrl404(`https://wtr-lab.com/en/novel/${cleanId}/${canonicalSlug}/chapter-${chNo}`);
          return null;
        } else if (readerRes.ok) {
          const data = await readerRes.json();
          const rawBody = data?.data?.data?.body;
          if (rawBody) {
            const decrypted = typeof rawBody === 'string' ? decryptWtrlabBody(rawBody) : rawBody;
            const cleanParas = deduplicateChapterParagraphs(Array.isArray(decrypted) ? decrypted.map(String) : []);
            if (cleanParas.length >= 2) {
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
        // Network timeout -> proceed seamlessly to browser-rendered Jina engine
      }
    }

    // Reliable Path 2: Browser-rendered WTR-Lab Live Extractor
    const live = await fetchWtrlabLiveChapterViaJina(
      cleanId,
      canonicalSlug,
      chNo,
      mode,
      params.novelTitle,
      priority,
      { retryWithCacheBust: true, timeoutMs: params.timeoutMs ?? 17000 }
    );

    if (live && live.paragraphs.length >= 2) {
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
