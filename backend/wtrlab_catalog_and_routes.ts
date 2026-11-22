  // Live Cover & Metadata Cache for Real WTR-Lab Series (keyed strictly by numeric novel ID)
  const WTRLAB_MAX_INDEXED_ID = 1600;
  const wtrlabLiveCoverMap = new Map<string, string>();
  const wtrlabLiveMetaCache = new Map<string, { data: any; fetchedAt: number }>();
  const wtrlabCoverBufferCache = new Map<string, { buffer: Buffer; contentType: string; cachedAt: number }>();
  let wtrlabFeedEnrichPromise: Promise<void> | null = null;
  let lastWtrlabFeedEnrichAt = 0;

  function resolveWtrlabNovelById(idNum: number, _urlSlug?: string): any {
    const idStr = String(idNum);
    if (wtrlabDynamicNovels.has(idStr)) {
      return wtrlabDynamicNovels.get(idStr);
    }
    const cachedMeta = wtrlabLiveMetaCache.get(idStr)?.data;
    if (cachedMeta && !cachedMeta.isPlaceholderIndex) {
      return cachedMeta;
    }
    return null;
  }

  function normalizeWtrlabCoverUrl(rawUrl?: string | null): string {
    const s = String(rawUrl || '').trim();
    if (!s || s.includes('images.unsplash.com') || s.startsWith('data:')) return '';
    if (/wtr-lab\.com\/(favicon|logo|og[-_]?image|apple-touch|icons?\/|placeholder\.png|default\.png)/i.test(s)) return '';
    let resolved = s;
    if (resolved.startsWith('//')) {
      resolved = `https:${resolved}`;
    } else if (resolved.startsWith('/')) {
      resolved = resolved.startsWith('/cdn/')
        ? `https://img.wtr-lab.com${resolved}`
        : `https://wtr-lab.com${resolved}`;
    } else if (!/^https?:\/\//i.test(resolved)) {
      resolved = resolved.startsWith('cdn/') ? `https://img.wtr-lab.com/${resolved}` : '';
    }
    if (!resolved) return '';
    return resolved.includes('/api/v2/img') ? resolved : resolved.split('?')[0];
  }

  function buildRichCoverSvg(rawTitle: string, rawAuthor?: string, rawId?: string): string {
    const title = (rawTitle || 'WTR-Lab Novel').replace(/\s+/g, ' ').trim();
    const author = (rawAuthor || 'WTR-Lab Archive').replace(/\s+/g, ' ').trim().slice(0, 28);
    const idLabel = rawId ? `#${rawId}` : 'WTR-LAB';

    let hash = 0;
    const seed = `${rawId || ''}:${title}:${author}`;
    for (let i = 0; i < seed.length; i++) {
      hash = ((hash << 5) - hash) + seed.charCodeAt(i);
      hash |= 0;
    }
    const palettes = [
      ['#0f172a', '#0c4a6e', '#38bdf8'],
      ['#1e1b4b', '#312e81', '#818cf8'],
      ['#064e3b', '#065f46', '#34d399'],
      ['#3b0764', '#581c87', '#c084fc'],
      ['#450a0a', '#7f1d1d', '#f87171'],
      ['#1c1917', '#78350f', '#fbbf24'],
      ['#042f2e', '#115e59', '#2dd4bf'],
      ['#4c0519', '#881337', '#fb7185'],
    ];
    const [bg1, bg2, accent] = palettes[Math.abs(hash) % palettes.length];
    const words = title.split(' ');
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length <= 16) {
        cur = (cur + ' ' + w).trim();
      } else {
        if (cur) lines.push(cur);
        cur = w.slice(0, 16);
      }
      if (lines.length >= 4) break;
    }
    if (cur && lines.length < 4) lines.push(cur);
    if (lines.length === 0) lines.push('Web Novel');

    const startY = 195 - ((lines.length - 1) * 16);
    const titleTspans = lines
      .map((line, i) => `<text x="158" y="${startY + i * 32}" fill="#f8fafc" font-size="21" font-family="Georgia, serif" font-weight="bold" text-anchor="middle">${escapeXml(line)}</text>`)
      .join('');

    return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="420" viewBox="0 0 300 420">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${bg1}"/><stop offset="100%" stop-color="${bg2}"/>
        </linearGradient>
      </defs>
      <rect width="300" height="420" fill="url(#bg)"/>
      <rect x="0" y="0" width="18" height="420" fill="#020617" opacity="0.55"/>
      <rect x="28" y="18" width="254" height="384" rx="10" fill="none" stroke="${accent}" stroke-opacity="0.4" stroke-width="1.5"/>
      <rect x="108" y="42" width="100" height="24" rx="12" fill="#020617" fill-opacity="0.7" stroke="${accent}" stroke-opacity="0.6"/>
      <text x="158" y="58" fill="${accent}" font-size="11" font-family="monospace" font-weight="bold" text-anchor="middle">${escapeXml(idLabel)}</text>
      <circle cx="158" cy="112" r="18" fill="none" stroke="${accent}" stroke-opacity="0.35" stroke-width="1.5"/>
      ${titleTspans}
      <line x1="88" y1="316" x2="228" y2="316" stroke="${accent}" stroke-opacity="0.45" stroke-width="1.5"/>
      <text x="158" y="348" fill="#cbd5e1" font-size="13" font-family="sans-serif" text-anchor="middle">${escapeXml(author)}</text>
      <text x="158" y="378" fill="${accent}" font-size="10" font-family="sans-serif" letter-spacing="2" text-anchor="middle" opacity="0.85">WTR-LAB EDITION</text>
    </svg>`;
  }

  function cleanWtrlabRawText(raw: string): string {
    return unescapeHtml(
      String(raw || '')
        .replace(/%\{([^|{}]+)\|[^}]+\}/g, '$1')
        .replace(/\s+/g, ' ')
        .trim()
    );
  }

  // Verified numeric genre ID -> label map from WTR-Lab __NEXT_DATA__
  const WTRLAB_GENRE_ID_MAP: Record<number, string> = {
    1: 'Action', 2: 'Adult', 3: 'Adventure', 4: 'Comedy', 5: 'Drama',
    6: 'Ecchi', 7: 'Eastern', 8: 'Fan-Fiction', 9: 'Fantasy', 10: 'Game',
    11: 'Gender Bender', 12: 'Harem', 13: 'Historical', 14: 'Horror', 15: 'Josei',
    16: 'Martial Arts', 17: 'Mature', 18: 'Mecha', 19: 'Mystery', 20: 'Psychological',
    21: 'Reincarnation', 22: 'Romance', 23: 'School Life', 24: 'Sci-Fi', 25: 'Seinen',
    26: 'Shoujo', 27: 'Shoujo Ai', 28: 'Shounen', 29: 'Shounen Ai', 30: 'Slice of Life',
    31: 'Smut', 32: 'Sports', 33: 'Supernatural', 34: 'Tragedy', 35: 'Urban Life',
    36: 'Wuxia', 37: 'Xianxia', 38: 'Yaoi', 39: 'Yuri',
  };

  const DEFAULT_GENRE_TAGS = ['Cultivation', 'Action', 'Fantasy', 'System', 'LitRPG', 'Mystery', 'Sci-Fi', 'Comedy', 'VRMMO'];

  function resolveWtrlabGenres(rawGenres: any, title = '', description = '', fallbackGenres?: string[]): string[] {
    const out: string[] = [];
    const pushUnique = (g: string) => {
      const trimmed = (g || '').trim();
      if (trimmed && !out.some((x) => x.toLowerCase() === trimmed.toLowerCase())) out.push(trimmed);
    };

    if (Array.isArray(rawGenres)) {
      for (const g of rawGenres) {
        if (typeof g === 'number' || (typeof g === 'string' && /^\d+$/.test(g.trim()))) {
          const mapped = WTRLAB_GENRE_ID_MAP[Number(g)];
          if (mapped) pushUnique(mapped);
        } else if (typeof g === 'string') {
          pushUnique(g);
        } else if (g && (g.title || g.name)) {
          pushUnique(String(g.title || g.name));
        }
      }
    }

    const hay = `${title} ${description}`.toLowerCase();
    if (out.some((x) => ['Xianxia', 'Wuxia', 'Martial Arts', 'Eastern'].includes(x)) || /\b(cultivat|immortal|dao\b|sect\b|qi\b|martial|xianxia|wuxia|murim|alchemy|nascent soul)\b/i.test(hay)) {
      pushUnique('Cultivation');
    }
    if (/\b(system|sign[- ]in|attribute panel|proficiency|simulator|cheat)\b/i.test(hay)) pushUnique('System');
    if (out.includes('Game') || /\b(litrpg|level up|skill tree|rpg|dungeon|status window|player)\b/i.test(hay)) pushUnique('LitRPG');
    if (/\b(vrmmo|virtual reality|full dive|vr game|mmorpg)\b/i.test(hay)) pushUnique('VRMMO');

    if (out.length === 0 && Array.isArray(fallbackGenres)) {
      for (const fg of fallbackGenres) pushUnique(fg);
    }
    if (out.length === 0) {
      pushUnique('Fantasy');
      pushUnique('Action');
    }
    return out.slice(0, 5);
  }

  function parseWtrlabNovelMarkdownFallback(md: string, novelId: string, slugHint?: string): any | null {
    if (!md || md.length < 200) return null;
    if (md.includes('Warning: Target URL returned error 404')) return null;

    const titleFromH1 = md.match(/^#\s+(.+)$/m)?.[1]?.trim() || '';
    const titleFromHead = (md.match(/^Title:\s*(.+)$/m)?.[1] || '')
      .replace(/^Read\s+/i, '')
      .replace(/\s+RAW\s+English\s+Translation.*$/i, '')
      .replace(/\s*[-|–—]\s*WTR-?LAB.*$/i, '')
      .trim();
    const realTitle = cleanWtrlabRawText(titleFromH1 || titleFromHead);
    if (!realTitle || /^wtr-?lab$/i.test(realTitle) || /adform\.net|404/i.test(realTitle)) return null;

    const chMatch =
      md.match(/\bChapters\s+(\d{1,6})\b/i) ||
      md.match(/\bAI-Unlock\s+Progress[\s\r\n]+(\d{1,6})\s*\/\s*(\d{1,6})\b/i);
    const chCount = chMatch ? parseInt(chMatch[2] || chMatch[1], 10) : 0;
    if (!chCount || chCount <= 0) return null;

    const statusMatch = md.match(/\bStatus[\s\r\n]+(Completed|Ongoing|Hiatus|Dropped)\b/i);
    const realStatus = statusMatch && /completed/i.test(statusMatch[1]) ? 'Completed' : 'Ongoing';

    let realAuthor = '';
    const authorLinks = [...md.matchAll(/\[([^\]]+)\]\(https:\/\/wtr-lab\.com\/[a-z]{2}\/author\/[^)]+\)/gi)].map((m) => m[1].trim());
    if (authorLinks.length > 0) {
      // Prefer romanized/Latin author name if WTR-Lab lists both raw CJK and Latin links
      realAuthor = authorLinks.find((a) => /[A-Za-z]/.test(a)) || authorLinks[0];
    }

    const slugFromUrl = md.match(/wtr-lab\.com\/[a-z]{2}\/novel\/\d+\/([a-z0-9][a-z0-9_-]*)/i)?.[1] || '';
    const realSlug =
      (slugFromUrl && slugFromUrl !== 'novel' ? slugFromUrl : '') ||
      (slugHint && slugHint !== 'novel' ? slugHint : '') ||
      realTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    const imgMatch = md.match(/!\[[^\]]*\]\((https:\/\/(?:img\.)?wtr-lab\.com\/[^)\s]+)\)/i);
    const realCover = normalizeWtrlabCoverUrl(imgMatch?.[1] || '');

    const summaryMatch = md.match(/Novel Summary[\s\r\n]+([\s\S]{20,900}?)(?:\r?\n\r?\n(?:Show more|Details|Edit History)|\r?\nDetails\b)/i);
    const realDesc = cleanWtrlabRawText(summaryMatch?.[1] || `Read ${realTitle} on WTR-Lab.`);

    return {
      title: realTitle,
      author: cleanWtrlabRawText(realAuthor || 'WTR-Lab Author'),
      slug: realSlug,
      coverUrl: realCover,
      chaptersCount: chCount,
      status: realStatus,
      description: realDesc,
    };
  }

  async function fetchWtrlabLiveMetadata(novelId: string, urlSlug?: string, forceRefresh = false): Promise<any | null> {
    const cacheKey = String(novelId).trim();
    const cached = wtrlabLiveMetaCache.get(cacheKey);
    const cachedHasCompleteMeta =
      cached?.data &&
      Number(cached.data.chaptersCount) > 0 &&
      !cached.data.hasUnverifiedCount &&
      cached.data.author &&
      cached.data.author !== 'WTR-Lab Author' &&
      cached.data.slug &&
      cached.data.slug !== 'novel';
    if (!forceRefresh && cached && cachedHasCompleteMeta && Date.now() - cached.fetchedAt < 15 * 60 * 1000) {
      return cached.data;
    }

    try {
      const existingPrev = wtrlabDynamicNovels.get(cacheKey);
      const effectiveSlug =
        (urlSlug && urlSlug !== 'novel' && !/^novel-\d+$/i.test(urlSlug) ? urlSlug : '') ||
        (existingPrev?.slug && existingPrev.slug !== 'novel' && !/^novel-\d+$/i.test(existingPrev.slug) ? existingPrev.slug : '');

      const targetNovelUrl = `https://wtr-lab.com/en/novel/${cacheKey}/${effectiveSlug || 'novel'}`;
      let html = await fetchWtrlabHtmlViaJina(targetNovelUrl, 12000, 'high', forceRefresh);
      if ((!html || !html.includes('__NEXT_DATA__')) && effectiveSlug) {
        html = await fetchWtrlabHtmlViaJina(`https://wtr-lab.com/en/novel/${cacheKey}/novel`, 12000, 'high', true);
      }
      if (!html || !html.includes('__NEXT_DATA__')) {
        // Retry once with explicit cache-bypass in case Jina served a cached tracker/CSR shell
        html = await fetchWtrlabHtmlViaJina(targetNovelUrl, 13000, 'high', true);
      }

      let sd: any = null;
      let ogImg = '';
      if (html && html.includes('__NEXT_DATA__')) {
        const $ = cheerio.load(html);
        ogImg = normalizeWtrlabCoverUrl($('meta[property="og:image"]').attr('content'));
        const nextDataRaw = $('#__NEXT_DATA__').html();
        if (nextDataRaw) {
          try {
            const parsed = JSON.parse(nextDataRaw);
            sd = parsed?.props?.pageProps?.serie?.serie_data || null;
          } catch {}
        }
      }

      // Secondary Fallback: Jina Markdown view of the novel page (extracts exact Chapters, Status, Author, Cover)
      if (!sd || !sd.data?.title) {
        const mdFallbackRaw = await fetchJinaWithHeaders(
          targetNovelUrl,
          { 'X-No-Cache': 'true', 'X-Retain-Images': 'all' },
          12000,
          'high'
        );
        const mdParsed = parseWtrlabNovelMarkdownFallback(mdFallbackRaw || '', cacheKey, effectiveSlug);
        if (mdParsed) {
          const realRawId = cacheKey;
          if (mdParsed.slug && mdParsed.slug !== 'novel') {
            wtrlabResolvedSlugCache.set(realRawId, mdParsed.slug);
          }
          if (mdParsed.chaptersCount > 0) {
            wtrlabKnownTotalChapters.set(realRawId, mdParsed.chaptersCount);
          }
          if (mdParsed.coverUrl) {
            wtrlabLiveCoverMap.set(realRawId, mdParsed.coverUrl);
            warmWtrlabCoverAsync(mdParsed.coverUrl);
          }
          const genresList = resolveWtrlabGenres(existingPrev?.rawGenreIds || [], mdParsed.title, mdParsed.description, existingPrev?.genres);
          const resolvedFromMd = {
            ...(existingPrev || {}),
            id: realRawId,
            rawId: realRawId,
            slug: mdParsed.slug,
            title: mdParsed.title,
            novelUrl: `https://wtr-lab.com/en/novel/${realRawId}/${mdParsed.slug}`,
            coverUrl: mdParsed.coverUrl || normalizeWtrlabCoverUrl(existingPrev?.coverUrl) || '',
            author: mdParsed.author,
            genres: genresList,
            chaptersCount: mdParsed.chaptersCount,
            hasUnverifiedCount: false,
            rating: existingPrev?.rating || 4.8,
            status: mdParsed.status,
            lastUpdated: 'Live WTR-Lab Sync',
            updatedAtMs: Date.now(),
            description: mdParsed.description,
            isRealWtrlab: true,
            isPlaceholderIndex: false,
          };
          wtrlabLiveMetaCache.set(cacheKey, { data: resolvedFromMd, fetchedAt: Date.now() });
          wtrlabDynamicNovels.set(realRawId, resolvedFromMd);
          scheduleWtrlabCatalogSave();
          return resolvedFromMd;
        }

        // Tertiary Fallback: Fast Chapter-1 SSR probe (recovers real totalChapters + canonical slug!)
        const ch1Probe = await probeWtrlabChapterSsrState(cacheKey, effectiveSlug || 'novel', 1, 'high');
        if (ch1Probe.totalChapters && ch1Probe.totalChapters > 0) {
          const pSlug = ch1Probe.realSlug || effectiveSlug || 'novel';
          const pTitle =
            existingPrev?.title ||
            (pSlug !== 'novel' ? pSlug.replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()) : `WTR-Lab Novel #${cacheKey}`);
          const resolvedFromProbe = {
            ...(existingPrev || {}),
            id: cacheKey,
            rawId: cacheKey,
            slug: pSlug,
            title: pTitle,
            novelUrl: `https://wtr-lab.com/en/novel/${cacheKey}/${pSlug}`,
            coverUrl: normalizeWtrlabCoverUrl(existingPrev?.coverUrl) || '',
            author: existingPrev?.author || 'WTR-Lab Author',
            genres: existingPrev?.genres || ['Action', 'Fantasy'],
            chaptersCount: ch1Probe.totalChapters,
            hasUnverifiedCount: false,
            status: existingPrev?.status || 'Ongoing',
            updatedAtMs: Date.now(),
            isRealWtrlab: true,
            isPlaceholderIndex: false,
          };
          wtrlabDynamicNovels.set(cacheKey, resolvedFromProbe);
          return resolvedFromProbe;
        }

        return existingPrev || null;
      }

      const realTitle = cleanWtrlabRawText(sd.data.title);
      const rawAuthor = cleanWtrlabRawText(sd.data.author || sd.author || sd.data?.raw?.author || '');
      const realAuthor = rawAuthor || (existingPrev?.author && existingPrev.author !== 'WTR-Lab Author' ? existingPrev.author : 'WTR-Lab Author');
      const realSlug = sd.slug || effectiveSlug || realTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const realRawId = String(sd.raw_id || cacheKey);

      // Register canonical slug immediately so chapter scraper never hits slug-redirect chapter shifts!
      if (realSlug && realSlug !== 'novel') {
        wtrlabResolvedSlugCache.set(realRawId, realSlug);
        wtrlabResolvedSlugCache.set(cacheKey, realSlug);
      }

      const seriesImg = normalizeWtrlabCoverUrl(sd.data.image || sd.image);
      const realCover = seriesImg || (ogImg.includes('/cdn/serie') ? ogImg : '');
      const maxSsrCount = Math.max(
        Number(sd.chapter_count || 0),
        Number(sd.raw_chapter_count || 0),
        Number(sd.unlock_count || 0),
        Number(wtrlabKnownTotalChapters.get(realRawId) || 0)
      );
      const realCount = maxSsrCount || existingPrev?.chaptersCount || 50;
      if (maxSsrCount > 0) {
        wtrlabKnownTotalChapters.set(realRawId, maxSsrCount);
        wtrlabKnownTotalChapters.set(cacheKey, maxSsrCount);
      }
      const realStatus =
        sd.status === 1 || sd.raw_status === 1 || String(sd.status).toLowerCase() === 'completed'
          ? 'Completed'
          : 'Ongoing';
      const realDesc = cleanWtrlabRawText(sd.data.description || `Read ${realTitle} on WTR-Lab.`);
      const rawGenreIds: number[] = Array.isArray(sd.genres)
        ? sd.genres.map((g: any) => Number(g)).filter((n: number) => !isNaN(n) && n > 0)
        : (existingPrev?.rawGenreIds || []);
      const genresList = resolveWtrlabGenres(sd.genres || rawGenreIds, realTitle, realDesc, existingPrev?.genres);

      if (realCover) {
        wtrlabLiveCoverMap.set(realRawId, realCover);
        warmWtrlabCoverAsync(realCover);
      }

      const prevCount = existingPrev?.chaptersCount || 0;
      const addedDelta = prevCount > 0 && realCount > prevCount ? realCount - prevCount : (existingPrev?.chaptersAdded || 0);
      const existingSafeCover = normalizeWtrlabCoverUrl(existingPrev?.coverUrl);
      const resolved = {
        ...(existingPrev || {}),
        id: realRawId,
        rawId: realRawId,
        slug: realSlug,
        title: realTitle,
        novelUrl: `https://wtr-lab.com/en/novel/${realRawId}/${realSlug}`,
        coverUrl: realCover || existingSafeCover || '',
        author: realAuthor,
        rawGenreIds,
        genres: genresList,
        chaptersCount: realCount,
        hasUnverifiedCount: maxSsrCount <= 0,
        chaptersAdded: addedDelta > 0 ? addedDelta : undefined,
        rating: sd.rating ? parseFloat(Number(sd.rating).toFixed(1)) : (existingPrev?.rating || 4.8),
        status: realStatus,
        lastUpdated: addedDelta > 0 ? `+${addedDelta} New Ch${addedDelta > 1 ? 's' : ''} · Live` : 'Live WTR-Lab Sync',
        updatedAtMs: Date.now(),
        description: realDesc,
        isRealWtrlab: true,
        isPlaceholderIndex: false,
      };
      wtrlabLiveMetaCache.set(cacheKey, { data: resolved, fetchedAt: Date.now() });
      wtrlabDynamicNovels.set(realRawId, resolved);
      scheduleWtrlabCatalogSave();
      return resolved;
    } catch {
      return wtrlabDynamicNovels.get(cacheKey) || null;
    }
  }

  let wtrlabRemoteTotalCount = 117465;
  let lastWtrlabSyncTime = 0;
  let lastDailyScheduleKey = '';
  let lastWtrlabSyncSummary = { harvestedCount: 0, updatedCount: 0, newCount: 0, reason: 'init' };
  const wtrlabHarvestedPages = new Set<string>();
  const WTRLAB_CATALOG_CACHE_FILE = path.join(RUNTIME_DIR, 'wtrlab_catalog_cache.json');
  const LEGACY_WTRLAB_CATALOG_CACHE_FILE = path.join(__dirname, 'wtrlab_catalog_cache.json');
  migrateLegacyFileToRuntime(LEGACY_WTRLAB_CATALOG_CACHE_FILE, WTRLAB_CATALOG_CACHE_FILE);
  let wtrlabDiskSaveTimer: NodeJS.Timeout | null = null;

  function scheduleWtrlabCatalogSave() {
    if (wtrlabDiskSaveTimer) return;
    wtrlabDiskSaveTimer = setTimeout(() => {
      wtrlabDiskSaveTimer = null;
      try {
        const novels = Array.from(wtrlabDynamicNovels.values()).slice(0, 25000);
        const covers = Array.from(wtrlabLiveCoverMap.entries()).slice(0, 30000);
        const harvested = Array.from(wtrlabHarvestedPages).slice(0, 5000);
        atomicWriteJsonFile(WTRLAB_CATALOG_CACHE_FILE, {
          updatedAt: Date.now(),
          lastDailySyncAt: lastWtrlabSyncTime,
          lastDailyScheduleKey,
          lastSyncSummary: lastWtrlabSyncSummary,
          remoteTotalCount: wtrlabRemoteTotalCount,
          novels,
          covers,
          harvested,
        }, true);
      } catch {}
    }, 1800);
  }

  function loadWtrlabCatalogFromDisk() {
    try {
      if (!fs.existsSync(WTRLAB_CATALOG_CACHE_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(WTRLAB_CATALOG_CACHE_FILE, 'utf-8'));
      if (Number(raw?.remoteTotalCount) > 50000) wtrlabRemoteTotalCount = Number(raw.remoteTotalCount);
      if (Number(raw?.lastDailySyncAt) > 0) lastWtrlabSyncTime = Number(raw.lastDailySyncAt);
      if (typeof raw?.lastDailyScheduleKey === 'string') lastDailyScheduleKey = raw.lastDailyScheduleKey;
      if (raw?.lastSyncSummary && typeof raw.lastSyncSummary === 'object') lastWtrlabSyncSummary = raw.lastSyncSummary;

      if (Array.isArray(raw?.novels)) {
        for (const item of raw.novels) {
          if (item?.id && item?.title && !item.isPlaceholderIndex && !String(item.description || '').includes('NovelCraft AES-GCM engine')) {
            const idStr = String(item.id);
            const genres = Array.isArray(item.genres) && item.genres.length > 0
              ? item.genres.filter(Boolean)
              : resolveWtrlabGenres(item.rawGenreIds || [], item.title, item.description);
            const cleanCover = normalizeWtrlabCoverUrl(item.coverUrl);
            if (item.slug && item.slug !== 'novel' && !/^novel-\d+$/i.test(item.slug)) {
              wtrlabResolvedSlugCache.set(idStr, item.slug);
            }
            wtrlabDynamicNovels.set(idStr, { ...item, coverUrl: cleanCover, genres, isRealWtrlab: true, isPlaceholderIndex: false });
          }
        }
      }

      if (Array.isArray(raw?.covers)) {
        for (const pair of raw.covers) {
          if (!Array.isArray(pair) || !pair[0] || !pair[1]) continue;
          const k = String(pair[0]).trim();
          if (!/^\d+$/.test(k) || !wtrlabDynamicNovels.has(k)) continue;
          const cleanUrl = normalizeWtrlabCoverUrl(pair[1]);
          if (!cleanUrl) continue;
          wtrlabLiveCoverMap.set(k, cleanUrl);
          const dyn = wtrlabDynamicNovels.get(k);
          if (dyn && !dyn.coverUrl) dyn.coverUrl = cleanUrl;
        }
      }

      if (Array.isArray(raw?.harvested)) {
        for (const u of raw.harvested) {
          if (typeof u === 'string' && u.startsWith('http')) wtrlabHarvestedPages.add(u);
        }
      }
    } catch {}
  }
  loadWtrlabCatalogFromDisk();

  // 3-Tier Priority Semaphore Pool for r.jina.ai with adaptive 429/422/5xx/ad-poison handling
  type JinaPriority = 'high' | 'medium' | 'low';
  const HAS_JINA_API_KEY = Boolean(process.env.JINA_API_KEY && process.env.JINA_API_KEY.trim());
  const MAX_HIGH_JINA_CONCURRENT = HAS_JINA_API_KEY ? 4 : 2;
  const MAX_MEDIUM_JINA_CONCURRENT = HAS_JINA_API_KEY ? 3 : 2;
  let activeHighJina = 0;
  let activeMediumJina = 0;
  let activeLowJina = 0;
  let activeWtrlabScrapeJobs = 0;
  let jinaRateLimitUntil = 0;
  let nextJinaDispatchAt = 0;
  let lastInteractiveJinaAt = 0;
  let jinaAdaptiveGapBonusMs = 0;
  const jinaWaiters: Array<{ priority: JinaPriority; resolve: () => void }> = [];

  function canRunJinaPriority(priority: JinaPriority): boolean {
    if (priority === 'high') return activeHighJina < MAX_HIGH_JINA_CONCURRENT;
    if (priority === 'medium') {
      if (activeWtrlabScrapeJobs > 0 || activeHighJina > 0) return false;
      if (jinaWaiters.some((w) => w.priority === 'high')) return false;
      return activeMediumJina < MAX_MEDIUM_JINA_CONCURRENT;
    }
    if (liveWtrlabSyncPromise || Date.now() < jinaRateLimitUntil) return false;
    return (
      activeLowJina === 0 &&
      activeMediumJina === 0 &&
      activeHighJina === 0 &&
      activeWtrlabScrapeJobs === 0 &&
      !jinaWaiters.some((w) => w.priority !== 'low') &&
      Date.now() - lastInteractiveJinaAt >= 18000
    );
  }

  function pumpJinaQueue() {
    while (jinaWaiters.length > 0) {
      for (const p of ['high', 'medium', 'low'] as JinaPriority[]) {
        const idx = jinaWaiters.findIndex((w) => w.priority === p);
        if (idx >= 0 && canRunJinaPriority(p)) {
          const [waiter] = jinaWaiters.splice(idx, 1);
          if (p === 'high') activeHighJina++;
          else if (p === 'medium') activeMediumJina++;
          else activeLowJina++;
          waiter.resolve();
          return pumpJinaQueue();
        }
      }
      break;
    }
  }

  function acquireJinaSlot(priority: JinaPriority): Promise<void> {
    const hasHigherWaiter = priority === 'high'
      ? jinaWaiters.some((w) => w.priority === 'high')
      : jinaWaiters.length > 0;
    if (!hasHigherWaiter && canRunJinaPriority(priority)) {
      if (priority === 'high') activeHighJina++;
      else if (priority === 'medium') activeMediumJina++;
      else activeLowJina++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      jinaWaiters.push({ priority, resolve });
    });
  }

  function releaseJinaSlot(priority: JinaPriority) {
    if (priority === 'high') activeHighJina = Math.max(0, activeHighJina - 1);
    else if (priority === 'medium') activeMediumJina = Math.max(0, activeMediumJina - 1);
    else activeLowJina = Math.max(0, activeLowJina - 1);
    pumpJinaQueue();
  }

  setInterval(() => {
    if (jinaWaiters.length > 0) pumpJinaQueue();
  }, 800);

  async function reserveJinaDispatchDelay(priority: JinaPriority): Promise<void> {
    if (priority !== 'low') lastInteractiveJinaAt = Date.now();
    const baseGapMs = HAS_JINA_API_KEY
      ? (priority === 'high' ? 380 : priority === 'medium' ? 750 : 3500)
      : (priority === 'high' ? 1150 : priority === 'medium' ? 1800 : 4000);
    const minGapMs = baseGapMs + (priority === 'low' ? 0 : jinaAdaptiveGapBonusMs);
    const now = Date.now();
    const startAt = Math.max(now, jinaRateLimitUntil, nextJinaDispatchAt);
    nextJinaDispatchAt = startAt + minGapMs;
    const waitMs = startAt - now;
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  }

  let lastJinaDebug = '';

  function isJinaPoisonedOrAdTrackerPayload(text: string): boolean {
    if (!text) return false;
    return (
      text.includes('adform.net') ||
      text.includes('monetixads') ||
      text.includes('admatic.de') ||
      text.includes('tacker probe') ||
      text.includes('doubleclick.net')
    );
  }

  async function fetchJinaWithHeaders(
    targetUrl: string,
    headers: Record<string, string>,
    timeoutMs = 17000,
    priority: JinaPriority = 'high'
  ): Promise<string | null> {
    if (isJinaUrlKnown404(targetUrl)) return null;
    await acquireJinaSlot(priority);
    const maxAttempts = priority === 'low' ? 2 : 3;
    let forceNoCacheNext = false;
    try {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await reserveJinaDispatchDelay(priority);
        try {
          const effectiveHeaders = forceNoCacheNext
            ? { ...headers, 'X-No-Cache': 'true' }
            : headers;
          const res = await fetch(`https://r.jina.ai/${targetUrl}`, {
            headers: effectiveHeaders,
            signal: AbortSignal.timeout(timeoutMs),
          });
          lastJinaDebug = `${res.status} (${targetUrl.replace('https://wtr-lab.com/en/', '')}) #${attempt + 1}`;

          if (res.status === 429) {
            let retrySec = 4 + attempt * 4;
            try {
              const parsed = JSON.parse(await res.text());
              if (Number(parsed?.retryAfter) > 0) retrySec = Math.max(retrySec, Number(parsed.retryAfter) + 1);
            } catch {}
            jinaAdaptiveGapBonusMs = Math.min(1800, jinaAdaptiveGapBonusMs + 450);
            const cooldownMs = Math.min(14000, retrySec * 1000) + 250 + Math.floor(Math.random() * 450);
            const until = Date.now() + Math.min(8500, cooldownMs);
            jinaRateLimitUntil = Math.max(jinaRateLimitUntil, until);
            nextJinaDispatchAt = Math.max(nextJinaDispatchAt, until);
            if (attempt < maxAttempts - 1) {
              await new Promise((r) => setTimeout(r, cooldownMs));
              continue;
            }
            return null;
          }

          if (res.status === 404) {
            markJinaUrl404(targetUrl);
            return null;
          }

          // IMPORTANT: Jina returns HTTP 422 when X-Wait-For-Selector timed out on slow CSR hydration OR on a missing chapter.
          // NEVER mark 422 as a permanent 404 here — let probeWtrlabChapterSsrState() authoritatively check __NEXT_DATA__!
          if (res.status === 422) {
            let bodyTxt = '';
            try { bodyTxt = await res.text(); } catch {}
            if (bodyTxt.includes('Warning: Target URL returned error 404')) {
              markJinaUrl404(targetUrl);
              return null;
            }
            return null;
          }

          if (res.status >= 500) {
            const backMs = 900 + attempt * 650;
            jinaRateLimitUntil = Math.max(jinaRateLimitUntil, Date.now() + backMs);
            if (attempt < maxAttempts - 1) {
              await new Promise((r) => setTimeout(r, backMs));
              continue;
            }
            return null;
          }

          if (!res.ok) return null;
          const text = await res.text();
          if (jinaAdaptiveGapBonusMs > 0) {
            jinaAdaptiveGapBonusMs = Math.max(0, jinaAdaptiveGapBonusMs - 100);
          }
          if (text.includes('Warning: Target URL returned error 404')) {
            markJinaUrl404(targetUrl);
            return text;
          }

          // Guard ALL endpoints (novel pages, search, HTML probes, AND chapters) against Jina cached ad-tracker poison!
          if (isJinaPoisonedOrAdTrackerPayload(text)) {
            forceNoCacheNext = true;
            if (attempt < maxAttempts - 1) {
              await new Promise((r) => setTimeout(r, 450 + attempt * 350));
              continue;
            }
            return null;
          }

          // If an HTML request returned a CSR shell without __NEXT_DATA__ on a cached snapshot, retry with X-No-Cache
          if (
            effectiveHeaders['X-Return-Format'] === 'html' &&
            !text.includes('__NEXT_DATA__') &&
            !effectiveHeaders['X-No-Cache'] &&
            attempt < maxAttempts - 1
          ) {
            forceNoCacheNext = true;
            await new Promise((r) => setTimeout(r, 350));
            continue;
          }

          const isExplicitEmptyWebShell =
            /[?&]service=web(?:&|$)/i.test(targetUrl) &&
            (text.includes('Prev') || text.includes('Ch.')) &&
            text.length < 900;
          const isTransientIncomplete =
            targetUrl.includes('/chapter-') &&
            !isExplicitEmptyWebShell &&
            !/AI Translation Requires Registration|Guests can preview AI translation/i.test(text) &&
            text.includes('Warning: This page maybe not yet fully loaded') &&
            text.length < 1400;

          if (isTransientIncomplete && attempt < maxAttempts - 1) {
            forceNoCacheNext = true;
            await new Promise((r) => setTimeout(r, 700 + attempt * 500));
            continue;
          }
          return text;
        } catch (err: any) {
          lastJinaDebug = `ERR:${err?.message || 'timeout'} (${targetUrl.replace('https://wtr-lab.com/en/', '')}) #${attempt + 1}`;
          jinaAdaptiveGapBonusMs = Math.min(1800, jinaAdaptiveGapBonusMs + 250);
          if (attempt < maxAttempts - 1) {
            forceNoCacheNext = true;
            await new Promise((r) => setTimeout(r, 700 + attempt * 550));
            continue;
          }
          return null;
        }
      }
      return null;
    } finally {
      releaseJinaSlot(priority);
    }
  }

  function fetchWtrlabHtmlViaJina(
    wtrUrl: string,
    timeoutMs = 10000,
    priority: JinaPriority = 'high',
    noCache = false
  ): Promise<string | null> {
    const hdrs: Record<string, string> = { 'X-Return-Format': 'html' };
    if (noCache) hdrs['X-No-Cache'] = 'true';
    return fetchJinaWithHeaders(wtrUrl, hdrs, timeoutMs, priority);
  }

  function normalizeNovelTitleKey(raw: string): string {
    return cleanWtrlabRawText(raw || '')
      .replace(/\(WTR-Lab #\d+\)/gi, '')
      .replace(/\[[^\]]+\]/g, '')
      .toLowerCase()
      .replace(/^(the|a|an)\s+/i, '')
      .replace(/[^a-z0-9]/g, '');
  }

  const wtrlabCoverWarmInflight = new Set<string>();
  let activeWarmCovers = 0;

  function warmWtrlabCoverAsync(coverUrl: string) {
    if (!coverUrl || coverUrl.includes('images.unsplash.com') || wtrlabCoverBufferCache.has(coverUrl) || wtrlabCoverWarmInflight.has(coverUrl) || wtrlabCoverBufferCache.size >= 420) {
      return;
    }
    wtrlabCoverWarmInflight.add(coverUrl);
    (async () => {
      while (activeWarmCovers >= 3) await new Promise((r) => setTimeout(r, 150));
      activeWarmCovers++;
      try {
        const fetchUrl = coverUrl.includes('wtr-lab.com')
          ? `https://wsrv.nl/?url=${encodeURIComponent(coverUrl)}&output=jpg`
          : coverUrl;
        const r = await fetch(fetchUrl, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'image/*,*/*;q=0.8' },
          signal: AbortSignal.timeout(6500),
        });
        if (r.ok) {
          const ct = (r.headers.get('content-type') || '').toLowerCase();
          if (ct.startsWith('image/')) {
            const buf = Buffer.from(await r.arrayBuffer());
            if (buf.byteLength >= 150) {
              wtrlabCoverBufferCache.set(coverUrl, { buffer: buf, contentType: ct.split(';')[0], cachedAt: Date.now() });
            }
          }
        }
      } catch {} finally {
        activeWarmCovers = Math.max(0, activeWarmCovers - 1);
        wtrlabCoverWarmInflight.delete(coverUrl);
      }
    })().catch(() => {});
  }

  function ingestWtrlabNextSeriesList(
    series: any[],
    tagLabel = 'Live WTR-Lab',
    opts?: { liveOrderBase?: number; newestOrderBase?: number }
  ): { items: any[]; updatedCount: number; newCount: number } {
    const ingested: any[] = [];
    if (!Array.isArray(series)) return { items: ingested, updatedCount: 0, newCount: 0 };
    let addedOrUpdated = false;
    let updatedCount = 0;
    let newCount = 0;
    const baseTime = Date.now();

    for (let idx = 0; idx < series.length; idx++) {
      const rawEntry = series[idx];
      const s = rawEntry?.serie || rawEntry?.novel || rawEntry;
      if (!s) continue;
      const rawId = String(s.raw_id || s.id || '');
      const title = s.data?.title ? cleanWtrlabRawText(s.data.title) : (s.title ? cleanWtrlabRawText(s.title) : '');
      const cleanImg = normalizeWtrlabCoverUrl(s.data?.image || s.image || '');
      const slug = s.slug || '';
      if (!rawId || !title) continue;

      if (slug && slug !== 'novel') {
        wtrlabResolvedSlugCache.set(rawId, slug);
      }
      const idNum = parseInt(rawId, 10);
      if (!isNaN(idNum) && idNum > wtrlabRemoteTotalCount) {
        wtrlabRemoteTotalCount = idNum;
      }

      if (cleanImg) {
        wtrlabLiveCoverMap.set(rawId, cleanImg);
        warmWtrlabCoverAsync(cleanImg);
        addedOrUpdated = true;
      }

      const rawChFromRecent = Array.isArray(rawEntry?.chapters) && rawEntry.chapters[0]?.order
        ? Number(rawEntry.chapters[0].order)
        : 0;
      const liveChCount = Number(s.chapter_count || s.raw_chapter_count || rawChFromRecent || 0);
      const liveStatus = s.status === 1 || s.raw_status === 1 ? 'Completed' : 'Ongoing';
      const parsedUpdateTs = s.updated_at ? Date.parse(String(s.updated_at)) : (s.last_chapter_at ? Date.parse(String(s.last_chapter_at)) : 0);
      const liveUpdatedAtMs = !isNaN(parsedUpdateTs) && parsedUpdateTs > 0
        ? parsedUpdateTs
        : (opts?.liveOrderBase !== undefined ? baseTime - (opts.liveOrderBase + idx) * 1000 : 0);

      const existing = wtrlabDynamicNovels.get(rawId);
      const rawGenreIds: number[] = Array.isArray(s.genres)
        ? s.genres.map((g: any) => Number(g)).filter((n: number) => !isNaN(n) && n > 0)
        : [];
      const liveAuthor = cleanWtrlabRawText(s.data?.author || s.author || '');
      const itemDescription = cleanWtrlabRawText(s.data?.description || existing?.description || `Live series on WTR-Lab: ${title}`);
      const genreNames = resolveWtrlabGenres(s.genres || rawGenreIds, title, itemDescription, existing?.genres);

      if (existing) {
        if (title && title !== existing.title) { existing.title = title; addedOrUpdated = true; }
        if (slug && slug !== existing.slug) {
          existing.slug = slug;
          existing.novelUrl = `https://wtr-lab.com/en/novel/${rawId}/${slug}`;
          addedOrUpdated = true;
        }
        if (liveAuthor && liveAuthor !== existing.author) { existing.author = liveAuthor; addedOrUpdated = true; }
        if (s.data?.description && itemDescription !== existing.description) { existing.description = itemDescription; addedOrUpdated = true; }
        if (cleanImg) existing.coverUrl = cleanImg;
        existing.isRealWtrlab = true;
        existing.isPlaceholderIndex = false;
        if (rawGenreIds.length > 0 && (!Array.isArray(existing.rawGenreIds) || existing.rawGenreIds.length === 0)) {
          existing.rawGenreIds = rawGenreIds;
        }
        if (!Array.isArray(existing.genres) || existing.genres.length === 0) {
          existing.genres = genreNames;
          addedOrUpdated = true;
        }

        const prevChCount = Number(existing.chaptersCount || 0);
        if (liveChCount > 0 && (liveChCount > prevChCount || existing.hasUnverifiedCount)) {
          const delta = prevChCount > 0 && !existing.hasUnverifiedCount ? liveChCount - prevChCount : 0;
          existing.chaptersCount = liveChCount;
          existing.hasUnverifiedCount = false;
          wtrlabKnownTotalChapters.set(rawId, Math.max(wtrlabKnownTotalChapters.get(rawId) || 0, liveChCount));
          if (delta > 0) {
            existing.chaptersAdded = (existing.chaptersAdded || 0) + delta;
            existing.lastUpdated = `+${existing.chaptersAdded} New Ch${existing.chaptersAdded > 1 ? 's' : ''} · Live`;
          }
          existing.updatedAtMs = Math.max(existing.updatedAtMs || 0, liveUpdatedAtMs || baseTime);
          existing.lastRefreshedAt = baseTime;
          updatedCount++;
          addedOrUpdated = true;
        }

        if (liveStatus !== existing.status) { existing.status = liveStatus; addedOrUpdated = true; }
        if (opts?.liveOrderBase !== undefined) {
          existing.liveUpdateRank = opts.liveOrderBase + idx;
          existing.updatedAtMs = Math.max(existing.updatedAtMs || 0, liveUpdatedAtMs || (baseTime - idx * 1000));
          existing.lastRefreshedAt = baseTime;
          if (!existing.chaptersAdded) existing.lastUpdated = 'Updated Live';
          updatedCount++;
          addedOrUpdated = true;
        }
        if (opts?.newestOrderBase !== undefined) {
          existing.newestRank = opts.newestOrderBase + idx;
          existing.lastRefreshedAt = baseTime;
          addedOrUpdated = true;
        }
        ingested.push(existing);
        continue;
      }

      if (liveChCount > 0) {
        wtrlabKnownTotalChapters.set(rawId, Math.max(wtrlabKnownTotalChapters.get(rawId) || 0, liveChCount));
      }

      const item: any = {
        id: rawId,
        rawId,
        slug: slug || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        title,
        novelUrl: `https://wtr-lab.com/en/novel/${rawId}/${slug || 'novel'}`,
        coverUrl: cleanImg,
        author: liveAuthor || 'WTR-Lab Author',
        rawGenreIds,
        genres: genreNames,
        chaptersCount: liveChCount || 100,
        hasUnverifiedCount: liveChCount <= 0,
        rating: s.rating ? parseFloat(Number(s.rating).toFixed(1)) : 4.8,
        status: liveStatus,
        lastUpdated: opts?.newestOrderBase !== undefined ? 'New Novel · Live' : opts?.liveOrderBase !== undefined ? 'Updated Live' : tagLabel,
        updatedAtMs: liveUpdatedAtMs || (baseTime - idx * 1000),
        liveUpdateRank: opts?.liveOrderBase !== undefined ? opts.liveOrderBase + idx : undefined,
        newestRank: opts?.newestOrderBase !== undefined ? opts.newestOrderBase + idx : undefined,
        description: itemDescription,
        isRealWtrlab: true,
        isPlaceholderIndex: false,
        discoveredAt: baseTime,
        crawledAt: baseTime,
      };
      wtrlabDynamicNovels.set(rawId, item);
      ingested.push(item);
      newCount++;
      addedOrUpdated = true;
    }
    if (addedOrUpdated) scheduleWtrlabCatalogSave();
    return { items: ingested, updatedCount, newCount };
  }

  /**
   * Harvests WTR-Lab pages via SSR __NEXT_DATA__ (supports /en homepage multi-rail payload
   * as well as /en/novel-finder and /en/novel-list).
   */
  async function harvestWtrlabPageUrl(
    wtrUrl: string,
    tagLabel = 'Live WTR-Lab',
    timeoutMs = 10000,
    forceRefresh = false,
    liveOrderBase?: number,
    priority: JinaPriority = 'high',
    newestOrderBase?: number
  ): Promise<any[]> {
    if (!forceRefresh && wtrlabHarvestedPages.has(wtrUrl)) return [];
    const html = await fetchWtrlabHtmlViaJina(wtrUrl, timeoutMs, priority);
    if (!html) return [];
    try {
      const ndMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!ndMatch) return [];
      const parsed = JSON.parse(ndMatch[1]);
      const pp = parsed?.props?.pageProps || {};
      const pageCountNum = Number(pp.count || 0);
      if (pageCountNum > 50000 && !wtrUrl.includes('text=') && !wtrUrl.includes('status=')) {
        wtrlabRemoteTotalCount = Math.max(wtrlabRemoteTotalCount, pageCountNum);
      }

      // If harvesting /en homepage directly, ingest all rich rails (recently, daily, trending, series, random) in 1 request!
      const isHomeRoot = /wtr-lab\.com\/en\/?$/i.test(wtrUrl);
      if (isHomeRoot) {
        const merged: any[] = [];
        if (Array.isArray(pp.recently)) merged.push(...ingestWtrlabNextSeriesList(pp.recently, 'Updated Live', { liveOrderBase: 0 }).items);
        if (Array.isArray(pp.daily)) merged.push(...ingestWtrlabNextSeriesList(pp.daily, 'Daily Trending').items);
        if (Array.isArray(pp.trending)) merged.push(...ingestWtrlabNextSeriesList(pp.trending, 'Trending').items);
        if (Array.isArray(pp.series)) merged.push(...ingestWtrlabNextSeriesList(pp.series, 'Live Newest', { newestOrderBase: 0 }).items);
        if (Array.isArray(pp.random)) merged.push(...ingestWtrlabNextSeriesList(pp.random, 'Featured').items);
        if (merged.length > 0) {
          wtrlabHarvestedPages.add(wtrUrl);
          wtrlabFeedSnapshotCache.clear();
          scheduleWtrlabCatalogSave();
        }
        return merged;
      }

      const list = pp.series || pp.ranking || pp.list || pp.novels || pp.items || [];
      if (Array.isArray(list) && list.length > 0) {
        wtrlabHarvestedPages.add(wtrUrl);
        scheduleWtrlabCatalogSave();
        const isOrderByUpdate = wtrUrl.includes('orderBy=update') || tagLabel === 'Latest Updates';
        const effectiveOrderBase = liveOrderBase !== undefined
          ? liveOrderBase
          : isOrderByUpdate
          ? ((Math.max(1, parseInt((wtrUrl.match(/page=(\d+)/)?.[1] || '1'), 10)) - 1) * 40)
          : undefined;
        const result = ingestWtrlabNextSeriesList(list, tagLabel, {
          liveOrderBase: effectiveOrderBase,
          newestOrderBase,
        });
        if (forceRefresh || isOrderByUpdate || newestOrderBase !== undefined) {
          wtrlabFeedSnapshotCache.clear();
        }
        return result.items;
      }
      return [];
    } catch {
      return [];
    }
  }

  const wtrlabFeedSnapshotCache = new Map<string, {
    items: any[];
    seenIds: Set<string>;
    seenTitleKeys: Set<string>;
    createdAt: number;
  }>();

  function getDeduplicatedWtrlabPool(): any[] {
    const byId = new Map<string, any>();
    const titleKeyToId = new Map<string, string>();

    for (const item of wtrlabDynamicNovels.values()) {
      if (!item || !item.id || !item.title || item.isPlaceholderIndex) continue;
      const id = String(item.id);
      const tKey = normalizeNovelTitleKey(item.title);
      const candidateCover = wtrlabLiveCoverMap.get(id) || normalizeWtrlabCoverUrl(item.coverUrl);

      if (tKey && titleKeyToId.has(tKey)) {
        const existingId = titleKeyToId.get(tKey)!;
        if (existingId !== id) {
          const prev = byId.get(existingId);
          const prevScore = (prev?.isRealWtrlab ? 8 : 0) + (prev?.coverUrl ? 2 : 0) + (prev?.chaptersCount || 0) / 100000;
          const nextScore = (item.isRealWtrlab ? 8 : 0) + (candidateCover ? 2 : 0) + (item.chaptersCount || 0) / 100000;
          if (nextScore > prevScore) {
            byId.delete(existingId);
            byId.set(id, { ...item, coverUrl: candidateCover });
            titleKeyToId.set(tKey, id);
          }
          continue;
        }
      }

      const existing = byId.get(id);
      if (existing) {
        byId.set(id, {
          ...existing,
          coverUrl: normalizeWtrlabCoverUrl(existing.coverUrl) || candidateCover,
          chaptersCount: Math.max(Number(existing.chaptersCount || 0), Number(item.chaptersCount || 0)) || existing.chaptersCount,
          isRealWtrlab: true,
        });
        continue;
      }

      byId.set(id, { ...item, coverUrl: candidateCover });
      if (tKey) titleKeyToId.set(tKey, id);
    }

    return Array.from(byId.values());
  }

  function formatWtrlabNovelCards(items: any[]) {
    return items.map((n) => {
      const resolvedCover = wtrlabLiveCoverMap.get(String(n.id)) || normalizeWtrlabCoverUrl(n.coverUrl);
      return {
        ...n,
        coverUrl: resolvedCover,
        proxiedCoverUrl: `/api/wtrlab/cover?url=${encodeURIComponent(resolvedCover)}&title=${encodeURIComponent(n.title || 'Novel')}&author=${encodeURIComponent(n.author || '')}&id=${encodeURIComponent(n.rawId || n.id || '')}`,
      };
    });
  }

  // Background Catalog Crawler Worker
  const CRAWL_QUEUE_TARGETS: Array<[string, string]> = [['https://wtr-lab.com/en', 'Homepage Live']];
  let maxQueuedCrawlPage = 0;

  function appendCrawlQueuePages(fromPage: number, toPage: number) {
    for (let p = fromPage; p <= toPage; p++) {
      if (p === 1) {
        CRAWL_QUEUE_TARGETS.push(
          ['https://wtr-lab.com/en/novel-finder?orderBy=update&page=1', 'Latest Updates'],
          ['https://wtr-lab.com/en/novel-finder?page=1', 'Live Newest'],
          ['https://wtr-lab.com/en/novel-list?page=1', 'Full Directory'],
          ['https://wtr-lab.com/en/novel-finder?orderBy=view&page=1', 'Most Viewed'],
          ['https://wtr-lab.com/en/novel-finder?orderBy=rating&page=1', 'Top Rated']
        );
        continue;
      }
      CRAWL_QUEUE_TARGETS.push([`https://wtr-lab.com/en/novel-finder?page=${p}`, 'Live Newest']);
      CRAWL_QUEUE_TARGETS.push([`https://wtr-lab.com/en/novel-list?page=${p}`, 'Full Directory']);
      if (p % 2 === 0 || p <= 60) {
        CRAWL_QUEUE_TARGETS.push([`https://wtr-lab.com/en/novel-finder?orderBy=view&page=${p}`, 'Most Viewed']);
      }
      if (p % 3 === 0 || p <= 40) {
        CRAWL_QUEUE_TARGETS.push([`https://wtr-lab.com/en/novel-finder?orderBy=update&page=${p}`, 'Latest Updates']);
      }
    }
    maxQueuedCrawlPage = Math.max(maxQueuedCrawlPage, toPage);
  }

  const retryQueueTargets: Array<[string, string]> = [];
  const wtrlabCrawlerState = {
    running: true,
    paused: false,
    cursor: 0,
    pagesCrawled: wtrlabHarvestedPages.size,
    currentTarget: wtrlabHarvestedPages.size > 0 ? 'Resumed cached catalog worker' : 'Initializing catalog worker...',
    lastBatchAdded: 0,
    lastUpdatedAt: Date.now(),
    isStepping: false,
  };

  function ensureCrawlQueueCapacity(minRemaining = 12) {
    if (CRAWL_QUEUE_TARGETS.length - wtrlabCrawlerState.cursor <= minRemaining && maxQueuedCrawlPage < 2500) {
      const startP = maxQueuedCrawlPage + 1;
      appendCrawlQueuePages(startP, Math.min(2500, startP + 99));
    }
  }
  appendCrawlQueuePages(1, 100);

  async function stepWtrlabCrawlerWorker(pagesToTry = 1, priority: JinaPriority = 'low'): Promise<number> {
    if (wtrlabCrawlerState.isStepping || wtrlabCrawlerState.paused || liveWtrlabSyncPromise) return 0;
    if (priority === 'low' && Date.now() < jinaRateLimitUntil) return 0;
    wtrlabCrawlerState.isStepping = true;
    let addedTotal = 0;
    try {
      ensureCrawlQueueCapacity(16);
      for (let i = 0; i < pagesToTry; i++) {
        if (liveWtrlabSyncPromise) break;
        let nextTarget: [string, string] | undefined;
        while (!nextTarget && wtrlabCrawlerState.cursor < CRAWL_QUEUE_TARGETS.length) {
          const cand = CRAWL_QUEUE_TARGETS[wtrlabCrawlerState.cursor++];
          if (!wtrlabHarvestedPages.has(cand[0])) nextTarget = cand;
        }
        if (!nextTarget && retryQueueTargets.length > 0) {
          const cand = retryQueueTargets.shift();
          if (cand && !wtrlabHarvestedPages.has(cand[0])) nextTarget = cand;
        }
        if (!nextTarget) {
          wtrlabCrawlerState.running = false;
          wtrlabCrawlerState.currentTarget = 'All queued catalog pages synced';
          break;
        }

        const [url, tag] = nextTarget;
        wtrlabCrawlerState.currentTarget = url.replace('https://wtr-lab.com/en', '') || '/en';
        const items = await harvestWtrlabPageUrl(url, tag, 10000, false, undefined, priority);
        if (items.length > 0) {
          addedTotal += items.length;
          wtrlabCrawlerState.pagesCrawled = wtrlabHarvestedPages.size;
        } else if (!wtrlabHarvestedPages.has(url)) {
          retryQueueTargets.push(nextTarget);
        }
        wtrlabCrawlerState.lastBatchAdded = addedTotal;
        wtrlabCrawlerState.lastUpdatedAt = Date.now();
      }
    } finally {
      wtrlabCrawlerState.isStepping = false;
    }
    return addedTotal;
  }

  async function ensureWtrlabLiveFeedEnriched(): Promise<void> {
    if (wtrlabDynamicNovels.size >= 35 || (Date.now() - lastWtrlabFeedEnrichAt < 20 * 60 * 1000 && wtrlabDynamicNovels.size >= 15)) {
      return;
    }
    if (wtrlabFeedEnrichPromise) {
      await Promise.race([wtrlabFeedEnrichPromise, new Promise((r) => setTimeout(r, 3500))]);
      return;
    }
    wtrlabFeedEnrichPromise = (async () => {
      try {
        lastWtrlabFeedEnrichAt = Date.now();
        await harvestWtrlabPageUrl('https://wtr-lab.com/en', 'Homepage Live', 9500, false, 0, 'high', 0);
        if (wtrlabDynamicNovels.size < 25) {
          await stepWtrlabCrawlerWorker(1, 'medium');
        }
      } finally {
        wtrlabFeedEnrichPromise = null;
      }
    })();
    await Promise.race([wtrlabFeedEnrichPromise, new Promise((r) => setTimeout(r, 4200))]);
  }

  setTimeout(() => { ensureWtrlabLiveFeedEnriched().catch(() => {}); }, 1500);

  setInterval(() => {
    if (liveWtrlabSyncPromise || activeWtrlabScrapeJobs > 0 || activeHighJina > 0 || Date.now() < jinaRateLimitUntil || Date.now() - lastInteractiveJinaAt < 18000) return;
    ensureCrawlQueueCapacity(10);
    if (!wtrlabCrawlerState.paused && wtrlabCrawlerState.running && (wtrlabCrawlerState.cursor < CRAWL_QUEUE_TARGETS.length || retryQueueTargets.length > 0)) {
      stepWtrlabCrawlerWorker(1, 'low').catch(() => {});
    }
  }, 14000);

  function getCrawlerStatusPayload() {
    const pool = getDeduplicatedWtrlabPool();
    let realCoversCount = 0;
    for (const n of pool) {
      if (n.coverUrl && !String(n.coverUrl).includes('images.unsplash.com')) realCoversCount++;
    }
    return {
      success: true,
      running: wtrlabCrawlerState.running && !wtrlabCrawlerState.paused,
      paused: wtrlabCrawlerState.paused,
      pagesCrawled: wtrlabHarvestedPages.size,
      totalQueuePages: CRAWL_QUEUE_TARGETS.length,
      remoteTotalCount: wtrlabRemoteTotalCount,
      realNovelsCount: pool.length,
      realCoversCount,
      cachedCoverBuffers: wtrlabCoverBufferCache.size,
      currentTarget: wtrlabCrawlerState.currentTarget,
      lastBatchAdded: wtrlabCrawlerState.lastBatchAdded,
      lastUpdatedAt: wtrlabCrawlerState.lastUpdatedAt,
    };
  }

  app.get('/api/wtrlab/crawler/status', (_req: Request, res: Response) => {
    res.json(getCrawlerStatusPayload());
  });

  app.post('/api/wtrlab/crawler/control', async (req: Request, res: Response) => {
    const action = String(req.body?.action || '').toLowerCase();
    if (action === 'pause') {
      wtrlabCrawlerState.paused = true;
    } else if (action === 'resume') {
      wtrlabCrawlerState.paused = false;
      wtrlabCrawlerState.running = true;
      stepWtrlabCrawlerWorker(2, 'medium').catch(() => {});
    } else if (action === 'boost') {
      wtrlabCrawlerState.paused = false;
      wtrlabCrawlerState.running = true;
      await Promise.race([stepWtrlabCrawlerWorker(3, 'medium'), new Promise((r) => setTimeout(r, 8500))]);
    } else if (action === 'restart') {
      wtrlabHarvestedPages.clear();
      retryQueueTargets.length = 0;
      wtrlabCrawlerState.cursor = 0;
      wtrlabCrawlerState.paused = false;
      wtrlabCrawlerState.running = true;
      await Promise.race([stepWtrlabCrawlerWorker(2, 'medium'), new Promise((r) => setTimeout(r, 6000))]);
    }
    res.json(getCrawlerStatusPayload());
  });

  app.get('/api/wtrlab/rails', async (req: Request, res: Response) => {
    try {
      await ensureWtrlabLiveFeedEnriched();
      const isSyncStale = Date.now() - lastWtrlabSyncTime > 15 * 60 * 1000 || needsOvernightOrDailyCatchup();
      if (req.query.refresh === '1' || isSyncStale) {
        await Promise.race([
          performDailyWtrlabLiveSync(req.query.refresh === '1' ? 'rails-refresh' : 'rails-stale-catchup'),
          new Promise((r) => setTimeout(r, 4500)),
        ]);
      }

      const pool = getDeduplicatedWtrlabPool();
      const usedIds = new Set<string>();
      const usedTitleKeys = new Set<string>();

      const takeUnique = (candidates: any[], limit: number) => {
        const picked: any[] = [];
        for (const item of candidates) {
          if (picked.length >= limit) break;
          const id = String(item.id);
          const tKey = normalizeNovelTitleKey(item.title);
          if (usedIds.has(id) || (tKey && usedTitleKeys.has(tKey))) continue;
          usedIds.add(id);
          if (tKey) usedTitleKeys.add(tKey);
          picked.push(item);
        }
        return formatWtrlabNovelCards(picked);
      };

      const daily = takeUnique(
        [...pool].sort((a, b) => {
          const aHasRank = typeof a.liveUpdateRank === 'number';
          const bHasRank = typeof b.liveUpdateRank === 'number';
          if (aHasRank && bHasRank && a.liveUpdateRank !== b.liveUpdateRank) return a.liveUpdateRank - b.liveUpdateRank;
          if (aHasRank !== bHasRank) return aHasRank ? -1 : 1;
          return (b.updatedAtMs || 0) - (a.updatedAtMs || 0);
        }),
        10
      );

      const trending = takeUnique(
        [...pool].sort((a, b) => ((b.chaptersCount || 100) * (b.rating || 4.5)) - ((a.chaptersCount || 100) * (a.rating || 4.5))),
        10
      );

      const topRated = takeUnique(
        [...pool].sort((a, b) => (b.rating || 0) - (a.rating || 0) || (b.chaptersCount || 0) - (a.chaptersCount || 0)),
        10
      );

      const cultivationKeywords = ['Cultivation', 'Murim', 'Xianxia', 'LitRPG', 'System', 'Martial Arts', 'Fantasy', 'Action'];
      const cultivation = takeUnique(
        pool.filter((n) => Array.isArray(n.genres) && n.genres.some((g: string) => cultivationKeywords.includes(g))),
        10
      );

      res.json({
        success: true,
        rails: { daily, trending, topRated, cultivation },
        crawler: getCrawlerStatusPayload(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to build WTR-Lab rails' });
    }
  });

  const wtrlabStreamPageCursor = new Map<string, number>();

  function buildRemoteWtrlabFeedUrl(sort: string, statusFilter: string, genre: string, remotePage: number): { url: string; tag: string } {
    const st = statusFilter.toLowerCase();
    const statusParam = st === 'completed' ? '&status=completed' : st === 'ongoing' ? '&status=ongoing' : '';
    const hasSpecificGenre = genre && genre !== 'All' && genre !== 'all';

    if (hasSpecificGenre && !statusParam && (sort === 'newest' || sort === 'daily')) {
      return { url: `https://wtr-lab.com/en/novel-finder?text=${encodeURIComponent(genre)}&page=${remotePage}`, tag: `${genre} Match` };
    }
    if (sort === 'popular') return { url: `https://wtr-lab.com/en/novel-finder?orderBy=view${statusParam}&page=${remotePage}`, tag: 'Most Viewed' };
    if (sort === 'rating') return { url: `https://wtr-lab.com/en/novel-finder?orderBy=rating${statusParam}&page=${remotePage}`, tag: 'Top Rated' };
    if (sort === 'chapters') return { url: `https://wtr-lab.com/en/novel-finder?orderBy=chapter${statusParam}&page=${remotePage}`, tag: 'Longest Series' };
    if (sort === 'daily' || sort === 'latest') return { url: `https://wtr-lab.com/en/novel-finder?orderBy=update${statusParam}&page=${remotePage}`, tag: 'Latest Updates' };
    if (sort === 'oldest') return { url: `https://wtr-lab.com/en/novel-list?page=${Math.max(1, 1100 - remotePage)}`, tag: 'Archive Series' };
    return { url: `https://wtr-lab.com/en/novel-finder?page=${remotePage}${statusParam}`, tag: 'Live Newest' };
  }

  app.get('/api/wtrlab/feed', async (req: Request, res: Response) => {
    try {
      await ensureWtrlabLiveFeedEnriched();
      const page = Math.max(0, parseInt((req.query.page as string) || '0', 10));
      const pageSize = Math.max(1, Math.min(100, parseInt((req.query.pageSize as string) || (req.query.limit as string) || '12', 10)));
      const search = ((req.query.search as string) || '').trim().toLowerCase();
      const sort = ((req.query.sort as string) || 'newest').toLowerCase();
      const genre = ((req.query.genre as string) || '').trim();
      const statusFilter = ((req.query.status as string) || '').trim();
      const era = ((req.query.era as string) || '').trim().toLowerCase();
      const fromId = req.query.fromId ? parseInt(req.query.fromId as string, 10) : undefined;
      const toId = req.query.toId ? parseInt(req.query.toId as string, 10) : undefined;
      const forceRefresh = req.query.refresh === '1';
      const excludeIdsRaw = ((req.query.excludeIds as string) || '').trim();
      const excludeIdSet = new Set(excludeIdsRaw ? excludeIdsRaw.split(',').map((s) => s.trim()).filter(Boolean) : []);

      if (search) {
        const idMatch = search.match(/novel\/(\d+)/i) || search.match(/^#?(\d+)$/);
        if (idMatch) {
          const queriedId = parseInt(idMatch[1], 10);
          if (queriedId > 0) {
            const liveMeta = await fetchWtrlabLiveMetadata(String(queriedId));
            if (liveMeta) wtrlabDynamicNovels.set(String(queriedId), liveMeta);
          }
        } else if (search.length >= 2) {
          await harvestWtrlabPageUrl(
            `https://wtr-lab.com/en/novel-finder?text=${encodeURIComponent(search)}&page=1`,
            'Search Match',
            6500,
            false,
            undefined,
            'high'
          );
        }
      }

      const genreMatchesFilter = (novelGenres: string[] | undefined, targetGenre: string): boolean => {
        if (!Array.isArray(novelGenres) || novelGenres.length === 0) return false;
        const t = targetGenre.toLowerCase();
        const aliases: Record<string, string[]> = {
          cultivation: ['cultivation', 'xianxia', 'wuxia', 'martial arts', 'eastern', 'murim'],
          litrpg: ['litrpg', 'game', 'rpg'],
          'sci-fi': ['sci-fi', 'mecha', 'space'],
          system: ['system', 'litrpg', 'game'],
          vrmmo: ['vrmmo', 'virtual reality', 'game', 'mmorpg'],
        };
        const accepted = aliases[t] || [t];
        return novelGenres.some((g) => accepted.includes(String(g).toLowerCase()));
      };

      const buildFilteredSortedCatalog = () => {
        let allNovels = getDeduplicatedWtrlabPool();

        if (era === 'classics') allNovels = allNovels.filter((n) => { const num = parseInt(n.rawId || n.id, 10); return num >= 1 && num <= 100; });
        else if (era === 'rising') allNovels = allNovels.filter((n) => { const num = parseInt(n.rawId || n.id, 10); return num >= 101 && num <= 300; });
        else if (era === 'golden') allNovels = allNovels.filter((n) => { const num = parseInt(n.rawId || n.id, 10); return num >= 301 && num <= 700; });
        else if (era === 'modern') allNovels = allNovels.filter((n) => { const num = parseInt(n.rawId || n.id, 10); return num >= 701 && num <= 1200; });
        else if (era === 'latest') allNovels = allNovels.filter((n) => parseInt(n.rawId || n.id, 10) >= 1201);

        if (typeof fromId === 'number' && !isNaN(fromId)) allNovels = allNovels.filter((n) => parseInt(n.rawId || n.id, 10) >= fromId);
        if (typeof toId === 'number' && !isNaN(toId)) allNovels = allNovels.filter((n) => parseInt(n.rawId || n.id, 10) <= toId);
        if (genre && genre !== 'All' && genre !== 'all') allNovels = allNovels.filter((n) => genreMatchesFilter(n.genres, genre));
        if (statusFilter && statusFilter !== 'All' && statusFilter !== 'all') {
          allNovels = allNovels.filter((n) => n.status && n.status.toLowerCase() === statusFilter.toLowerCase());
        }
        if (search) {
          allNovels = allNovels.filter((n) => {
            const nid = String(n.id);
            const rawId = String(n.rawId || '');
            return (
              nid === search ||
              rawId === search ||
              (n.title || '').toLowerCase().includes(search) ||
              (n.author || '').toLowerCase().includes(search) ||
              (n.slug || '').toLowerCase().includes(search) ||
              (n.genres || []).join(' ').toLowerCase().includes(search)
            );
          });
        }

        if (sort === 'newest') {
          allNovels.sort((a, b) => (parseInt(b.rawId || b.id, 10) || 0) - (parseInt(a.rawId || a.id, 10) || 0));
        } else if (sort === 'oldest') {
          allNovels.sort((a, b) => (parseInt(a.rawId || a.id, 10) || 0) - (parseInt(b.rawId || b.id, 10) || 0));
        } else if (sort === 'rating') {
          allNovels.sort((a, b) => (b.rating || 0) - (a.rating || 0));
        } else if (sort === 'chapters') {
          allNovels.sort((a, b) => (b.chaptersCount || 0) - (a.chaptersCount || 0));
        } else if (sort === 'popular') {
          allNovels.sort((a, b) => ((b.rating || 4.5) * (b.chaptersCount || 100)) - ((a.rating || 4.5) * (a.chaptersCount || 100)));
        } else if (sort === 'alphabetical') {
          allNovels.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
        } else {
          allNovels.sort((a, b) => {
            const aHasRank = typeof a.liveUpdateRank === 'number';
            const bHasRank = typeof b.liveUpdateRank === 'number';
            if (aHasRank && bHasRank && a.liveUpdateRank !== b.liveUpdateRank) return a.liveUpdateRank - b.liveUpdateRank;
            if (aHasRank !== bHasRank) return aHasRank ? -1 : 1;
            return (b.updatedAtMs || 0) - (a.updatedAtMs || 0);
          });
        }
        return allNovels;
      };

      const offset = page * pageSize;
      const streamKey = `${sort}:${genre || 'All'}:${statusFilter || 'All'}`;
      if (!search && (!era || era === 'all') && fromId === undefined && toId === undefined && activeWtrlabScrapeJobs === 0) {
        const preCheckCount = buildFilteredSortedCatalog().length;
        if (preCheckCount < offset + pageSize + 10) {
          let cursor = wtrlabStreamPageCursor.get(streamKey) || 1;
          const pullDeadline = Date.now() + 4500;
          let pulledPages = 0;
          let scannedAttempts = 0;
          while (pulledPages < 2 && scannedAttempts < 60 && Date.now() < pullDeadline) {
            scannedAttempts++;
            const candidate = buildRemoteWtrlabFeedUrl(sort, statusFilter, genre, cursor++);
            if (wtrlabHarvestedPages.has(candidate.url)) continue;
            const got = await Promise.race([
              harvestWtrlabPageUrl(candidate.url, candidate.tag, 5000, false, undefined, 'medium'),
              new Promise<any[]>((r) => setTimeout(() => r([]), 2600)),
            ]);
            pulledPages++;
            if (got.length === 0) break;
          }
          wtrlabStreamPageCursor.set(streamKey, cursor);
        }
      }

      const snapshotKey = `${sort}:${genre}:${statusFilter}:${era}:${fromId || ''}:${toId || ''}:${search}`;
      let snapshot = wtrlabFeedSnapshotCache.get(snapshotKey);

      if (page === 0 || forceRefresh || !snapshot || Date.now() - snapshot.createdAt > 15 * 60 * 1000) {
        const freshList = buildFilteredSortedCatalog();
        const seenIds = new Set<string>(freshList.map((x) => String(x.id)));
        const seenTitleKeys = new Set<string>(freshList.map((x) => normalizeNovelTitleKey(x.title)).filter(Boolean));
        snapshot = { items: freshList, seenIds, seenTitleKeys, createdAt: Date.now() };
        if (wtrlabFeedSnapshotCache.size > 30) {
          const oldestKey = wtrlabFeedSnapshotCache.keys().next().value;
          if (oldestKey) wtrlabFeedSnapshotCache.delete(oldestKey);
        }
        wtrlabFeedSnapshotCache.set(snapshotKey, snapshot);
      } else {
        for (const item of buildFilteredSortedCatalog()) {
          const id = String(item.id);
          const tk = normalizeNovelTitleKey(item.title);
          if (snapshot.seenIds.has(id) || (tk && snapshot.seenTitleKeys.has(tk))) continue;
          snapshot.seenIds.add(id);
          if (tk) snapshot.seenTitleKeys.add(tk);
          snapshot.items.push(item);
        }
      }

      const allNovels = snapshot.items;
      const genresSet = new Set<string>(DEFAULT_GENRE_TAGS);
      for (const n of wtrlabDynamicNovels.values()) {
        if (Array.isArray(n?.genres)) for (const g of n.genres) genresSet.add(g);
      }

      let pagedItems = allNovels.slice(offset, offset + pageSize);
      if (excludeIdSet.size > 0) {
        pagedItems = [];
        for (let i = offset; i < allNovels.length && pagedItems.length < pageSize; i++) {
          if (!excludeIdSet.has(String(allNovels[i].id))) pagedItems.push(allNovels[i]);
        }
      }
      const hasRemoteCapacity = !search && (!era || era === 'all') && fromId === undefined && toId === undefined && allNovels.length < wtrlabRemoteTotalCount;
      const formattedNovels = formatWtrlabNovelCards(pagedItems);

      res.json({
        success: true,
        source: 'wtr-lab',
        novels: formattedNovels,
        page,
        pageSize,
        totalAvailable: allNovels.length,
        realNovelsCount: allNovels.length,
        remoteTotalCount: wtrlabRemoteTotalCount,
        totalFetched: formattedNovels.length,
        hasMore: offset + pageSize < allNovels.length || hasRemoteCapacity,
        genres: Array.from(genresSet).sort(),
        sort,
        era: era || 'all',
        minId: 1,
        maxId: Math.max(WTRLAB_MAX_INDEXED_ID, ...allNovels.map((n) => parseInt(n.rawId || n.id, 10) || 1)),
        crawler: getCrawlerStatusPayload(),
        timestamp: Date.now(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch WTR-Lab feed' });
    }
  });

  // ==========================================
  // WTR-LAB LIVE UPDATES & DAILY 8:30 PM IST SYNC ENGINE
  // ==========================================
  let liveWtrlabSyncPromise: Promise<{ harvestedCount: number; updatedCount: number; newCount: number }> | null = null;
  let lastSyncRetryTimer: NodeJS.Timeout | null = null;

  function getNextIst830PmDate(): Date {
    const now = new Date();
    const targetUtc = new Date(now);
    targetUtc.setUTCHours(15, 0, 0, 0);
    if (targetUtc.getTime() <= now.getTime()) targetUtc.setUTCDate(targetUtc.getUTCDate() + 1);
    return targetUtc;
  }

  function getMostRecentIst830PmDate(): Date {
    const now = new Date();
    const targetUtc = new Date(now);
    targetUtc.setUTCHours(15, 0, 0, 0);
    if (targetUtc.getTime() > now.getTime()) targetUtc.setUTCDate(targetUtc.getUTCDate() - 1);
    return targetUtc;
  }

  function getScheduleBoundaryKey(date = getMostRecentIst830PmDate()): string {
    return date.toISOString().slice(0, 10);
  }

  function needsOvernightOrDailyCatchup(): boolean {
    const mostRecentBoundary = getMostRecentIst830PmDate();
    if (lastWtrlabSyncTime <= 0) return true;
    if (lastDailyScheduleKey !== getScheduleBoundaryKey(mostRecentBoundary)) return true;
    if (lastWtrlabSyncTime < mostRecentBoundary.getTime()) return true;
    return Date.now() - lastWtrlabSyncTime > 4 * 60 * 60 * 1000;
  }

  const wtrlabSyncTrace: string[] = [];
  function pushWtrlabSyncTrace(msg: string) {
    wtrlabSyncTrace.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
    if (wtrlabSyncTrace.length > 10) wtrlabSyncTrace.shift();
  }

  async function performDailyWtrlabLiveSync(reason = 'manual'): Promise<{ harvestedCount: number; updatedCount: number; newCount: number }> {
    if (liveWtrlabSyncPromise) return liveWtrlabSyncPromise;

    liveWtrlabSyncPromise = (async () => {
      pushWtrlabSyncTrace(`START ${reason}`);
      lastInteractiveJinaAt = Date.now();
      const beforeCount = wtrlabDynamicNovels.size;
      let totalHarvested = 0;
      const seenUpdated = new Set<string>();
      let consecutiveFailures = 0;

      const targets: Array<{ url: string; tag: string; rankBase?: number; newestBase?: number }> = [
        { url: 'https://wtr-lab.com/en', tag: 'Homepage Live', rankBase: 0, newestBase: 0 },
        { url: 'https://wtr-lab.com/en/novel-finder?orderBy=update&page=1', tag: 'Latest Updates', rankBase: 0 },
        { url: 'https://wtr-lab.com/en/novel-finder?page=1', tag: 'Live Newest', newestBase: 0 },
      ];

      for (let i = 0; i < targets.length; i++) {
        if (activeWtrlabScrapeJobs > 0) break;
        const target = targets[i];
        try {
          if (i > 0) await new Promise((r) => setTimeout(r, 1200));
          const syncPrio: JinaPriority = reason === 'manual' ? 'high' : 'medium';
          const items = await harvestWtrlabPageUrl(target.url, target.tag, 13000, true, target.rankBase, syncPrio, target.newestBase);
          pushWtrlabSyncTrace(`T${i}:${items.length} [${lastJinaDebug}]`);
          if (items.length > 0) {
            totalHarvested += items.length;
            consecutiveFailures = 0;
            for (const it of items) if (it?.id) seenUpdated.add(String(it.id));
          } else if (++consecutiveFailures >= 2) {
            break;
          }
        } catch (err: any) {
          pushWtrlabSyncTrace(`T${i}:ERR ${err?.message || ''}`);
          if (++consecutiveFailures >= 2) break;
        }
      }

      const newCount = Math.max(0, wtrlabDynamicNovels.size - beforeCount);
      if (totalHarvested > 0) {
        lastWtrlabSyncTime = Date.now();
        lastDailyScheduleKey = getScheduleBoundaryKey();
        lastWtrlabSyncSummary = { harvestedCount: totalHarvested, updatedCount: seenUpdated.size, newCount, reason };
        wtrlabLiveMetaCache.clear();
        wtrlabFeedSnapshotCache.clear();
        scheduleWtrlabCatalogSave();
      } else if (!lastSyncRetryTimer) {
        lastSyncRetryTimer = setTimeout(() => {
          lastSyncRetryTimer = null;
          if (activeWtrlabScrapeJobs === 0) performDailyWtrlabLiveSync(`${reason}-retry`).catch(() => {});
        }, 35000);
      }

      return { harvestedCount: totalHarvested, updatedCount: seenUpdated.size, newCount };
    })().finally(() => {
      liveWtrlabSyncPromise = null;
      lastInteractiveJinaAt = Date.now();
    });

    return liveWtrlabSyncPromise;
  }

  let scheduledRefreshTimer: NodeJS.Timeout | null = null;
  function scheduleWtrlabDailyRefresh() {
    if (scheduledRefreshTimer) clearTimeout(scheduledRefreshTimer);
    const nextTarget = getNextIst830PmDate();
    scheduledRefreshTimer = setTimeout(() => {
      performDailyWtrlabLiveSync('daily-830pm-ist')
        .catch(() => {})
        .finally(() => scheduleWtrlabDailyRefresh());
    }, nextTarget.getTime() - Date.now());
  }
  scheduleWtrlabDailyRefresh();

  setTimeout(() => {
    if (needsOvernightOrDailyCatchup() && activeWtrlabScrapeJobs === 0) {
      performDailyWtrlabLiveSync('overnight-catchup').catch(() => {});
    }
  }, 2200);

  setInterval(() => {
    if (activeWtrlabScrapeJobs > 0 || activeHighJina > 0 || Date.now() - lastInteractiveJinaAt < 20000) return;
    if (needsOvernightOrDailyCatchup()) {
      performDailyWtrlabLiveSync('missed-schedule-catchup').catch(() => {});
    }
  }, 3 * 60 * 1000);

  app.get('/api/wtrlab/schedule', (_req: Request, res: Response) => {
    const nextDate = getNextIst830PmDate();
    const now = Date.now();
    res.json({
      success: true,
      scheduledTimeFormatted: '8:30 PM IST (Daily) · Auto-Live',
      timezone: 'Asia/Kolkata (IST, UTC+5:30)',
      nextRefreshIso: nextDate.toISOString(),
      nextRefreshTimestamp: nextDate.getTime(),
      countdownSeconds: Math.max(0, Math.floor((nextDate.getTime() - now) / 1000)),
      lastRefreshedAt: lastWtrlabSyncTime,
      lastRefreshedIso: lastWtrlabSyncTime > 0 ? new Date(lastWtrlabSyncTime).toISOString() : '',
      lastDailyScheduleKey,
      lastSyncSummary: lastWtrlabSyncSummary,
      syncInProgress: Boolean(liveWtrlabSyncPromise),
      systemUtcTime: new Date().toISOString(),
      syncDebug: {
        lastJinaDebug,
        activeHighJina,
        activeMediumJina,
        activeLowJina,
        waiters: jinaWaiters.length,
        rateLimitInMs: Math.max(0, jinaRateLimitUntil - now),
        trace: wtrlabSyncTrace.slice(-6),
      },
    });
  });

  app.post('/api/wtrlab/schedule/sync-now', async (_req: Request, res: Response) => {
    const result = await Promise.race([
      performDailyWtrlabLiveSync('manual'),
      new Promise<{ harvestedCount: number; updatedCount: number; newCount: number }>((resolve) =>
        setTimeout(() => resolve({ harvestedCount: 0, updatedCount: 0, newCount: 0 }), 26000)
      ),
    ]);
    const nextDate = getNextIst830PmDate();
    res.json({
      success: true,
      message: result.harvestedCount > 0
        ? `Synced ${result.harvestedCount} live novels from WTR-Lab (${result.newCount} new, ${result.updatedCount} refreshed)`
        : 'WTR-Lab live catalog sync completed',
      ...result,
      lastRefreshedAt: lastWtrlabSyncTime,
      nextRefreshIso: nextDate.toISOString(),
      countdownSeconds: Math.max(0, Math.floor((nextDate.getTime() - Date.now()) / 1000)),
    });
  });

  // WTR-Lab Novel Details & Chapters Manifest Endpoint
  app.get('/api/wtrlab/novel/:id', async (req: Request, res: Response) => {
    try {
      const novelId = String(req.params.id).trim();
      const forceRefresh = req.query.refresh === '1';
      const numId = parseInt(novelId, 10);
      let matched: any = (!isNaN(numId) && numId > 0)
        ? resolveWtrlabNovelById(numId)
        : wtrlabDynamicNovels.get(novelId);

      const hasGeneratedTitle = !matched || !matched.title || Boolean(matched.isPlaceholderIndex) || /^WTR-Lab Novel #?\d+$/i.test(matched.title);
      const isMetaStale = !matched?.updatedAtMs || (Date.now() - Number(matched.updatedAtMs) > 15 * 60 * 1000);
      const safeCachedCover = normalizeWtrlabCoverUrl(matched?.coverUrl);

      if (forceRefresh || hasGeneratedTitle || !safeCachedCover || (isMetaStale && activeWtrlabScrapeJobs === 0)) {
        const liveMeta = await fetchWtrlabLiveMetadata(novelId, matched?.slug, forceRefresh || isMetaStale).catch(() => null);
        if (liveMeta) {
          matched = { ...(matched || {}), ...liveMeta, id: novelId };
          wtrlabDynamicNovels.set(novelId, matched);
        }
      }

      const resolvedTitle = matched?.title || `WTR-Lab Novel ${novelId}`;
      const resolvedAuthor = matched?.author || 'WTR-Lab Author';
      const resolvedSlug = matched?.slug || wtrlabResolvedSlugCache.get(novelId) || `novel-${novelId}`;
      const resolvedCoverUrl = wtrlabLiveCoverMap.get(novelId) || normalizeWtrlabCoverUrl(matched?.coverUrl);
      const proxiedCoverUrl = `/api/wtrlab/cover?url=${encodeURIComponent(resolvedCoverUrl)}&title=${encodeURIComponent(resolvedTitle)}&author=${encodeURIComponent(resolvedAuthor)}&id=${encodeURIComponent(novelId)}`;
      const totalChapters = Math.max(1, Number(matched?.chaptersCount) || 50);

      const chapters = Array.from({ length: Math.min(totalChapters, 5000) }, (_, i) => ({
        id: `wtr_${novelId}_${i + 1}`,
        order: i + 1,
        title: `Chapter ${i + 1}`,
        url: `https://wtr-lab.com/en/novel/${novelId}/${resolvedSlug}/chapter-${i + 1}`,
      }));

      res.json({
        success: true,
        novel: {
          id: novelId,
          title: resolvedTitle,
          author: resolvedAuthor,
          slug: resolvedSlug,
          novelUrl: `https://wtr-lab.com/en/novel/${novelId}/${resolvedSlug}`,
          coverUrl: resolvedCoverUrl,
          proxiedCoverUrl,
          genres: matched?.genres || ['Action', 'Fantasy'],
          status: matched?.status || 'Ongoing',
          lastUpdated: matched?.lastUpdated || 'Live WTR-Lab Sync',
          chaptersAdded: matched?.chaptersAdded || 0,
          totalChapters,
          chapters,
          description: matched?.description || `Read ${resolvedTitle} on WTR-Lab.`,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch WTR-Lab novel details' });
    }
  });

  type WtrlabServiceMode = 'web' | 'webplus' | 'ai';

  function normalizeServiceMode(raw?: string): WtrlabServiceMode {
    const s = String(raw || '').trim().toLowerCase();
    if (s === 'web') return 'web';
    if (s === 'webplus' || s === 'web+') return 'webplus';
    return 'ai';
  }

  async function processChapterByServiceMode(params: {
    title: string;
    paragraphs: string[];
    serviceMode: WtrlabServiceMode;
    novelTitle?: string;
    allowGeminiPolish?: boolean;
  }): Promise<{ title: string; paragraphs: string[]; serviceMode: WtrlabServiceMode; engineLabel: string }> {
    const { title, paragraphs, serviceMode } = params;
    const cleanedTitle = cleanWtrlabRawText(title || 'Chapter');
    const dedupedRaw = deduplicateChapterParagraphs(
      (paragraphs || []).map((p) => cleanWtrlabRawText(p)).filter(Boolean)
    );

    if (serviceMode === 'web' || dedupedRaw.length === 0) {
      return {
        title: cleanedTitle,
        paragraphs: dedupedRaw,
        serviceMode: 'web',
        engineLabel: 'Web · Original MTL',
      };
    }

    const promoNoise = [
      /^read\s+(?:latest\s+)?chapters?\s+(?:at|on)\s+/i,
      /^please\s+bookmark/i,
      /^(?:source|translator)\s*note\s*:/i,
    ];
    const filtered = dedupedRaw.filter((p) => !promoNoise.some((rx) => rx.test(p)));
    const safeBase = filtered.length >= 2 ? filtered : dedupedRaw;

    const formattedParas = safeBase.map((p) =>
      p
        .replace(/\s+([,.;:!?])/g, '$1')
        .replace(/\s{2,}/g, ' ')
        .trim()
    );

    return {
      title: cleanedTitle,
      paragraphs: formattedParas,
      serviceMode,
      engineLabel: serviceMode === 'webplus' ? 'Web+ · Glossary Enhanced' : 'AI · Clean Prose',
    };
  }

  // WTR-Lab Chapter Decrypt & Fetch Endpoint (strictly WTR-Lab — zero fake/third-party mirror contamination)
  app.post('/api/wtrlab/chapter', async (req: Request, res: Response) => {
    try {
      const { encryptedBody, novelId, chapterNo, slug, title: reqTitle, serviceMode: rawMode } = req.body || {};
      const serviceMode = normalizeServiceMode(rawMode);

      if (encryptedBody) {
        const rawParas = decryptWtrlabBody(encryptedBody);
        const processed = await processChapterByServiceMode({
          title: reqTitle || 'Chapter',
          paragraphs: rawParas,
          serviceMode,
          allowGeminiPolish: false,
        });
        res.json({ success: true, paragraphs: processed.paragraphs, serviceMode, engineLabel: processed.engineLabel, decrypted: true });
        return;
      }

      if (!novelId || !chapterNo) {
        res.status(400).json({ success: false, error: 'novelId and chapterNo are required' });
        return;
      }

      const numCh = Math.max(1, parseInt(String(chapterNo), 10));
      const cleanId = String(novelId).trim();
      const matched = wtrlabDynamicNovels.get(cleanId);
      const effectiveTitle = reqTitle || matched?.title;

      const scraped = await scrapeWtrlabChapterClean({
        novelId: cleanId,
        slug: matched?.slug || slug,
        chapterNo: numCh,
        serviceMode,
        language: 'en',
        novelTitle: effectiveTitle,
        priority: 'high',
      });

      if (scraped && scraped.paragraphs.length >= 1) {
        const processed = await processChapterByServiceMode({
          title: scraped.title,
          paragraphs: scraped.paragraphs,
          serviceMode,
          novelTitle: effectiveTitle,
          allowGeminiPolish: false,
        });
        const cacheKey = `${cleanId}:${numCh}:en:${serviceMode}:en`;
        wtrlabChapterCache.set(cacheKey, { title: processed.title, paragraphs: processed.paragraphs, timestamp: Date.now() });
        res.json({
          success: true,
          title: processed.title,
          paragraphs: processed.paragraphs,
          serviceMode,
          engineLabel: processed.engineLabel,
          wordCount: processed.paragraphs.join(' ').split(/\s+/).filter(Boolean).length,
          decrypted: true,
          cached: scraped.origin === 'cache',
        });
        return;
      }

      res.status(502).json({
        success: false,
        error: `Could not extract verified Chapter ${numCh} for "${effectiveTitle || `Novel #${cleanId}`}" from wtr-lab.com. Please retry.`,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Chapter extraction failed' });
    }
  });

  type WtrlabChapterVerifyResult = {
    novelId: string;
    chapterNo: number;
    serviceMode: WtrlabServiceMode;
    verdict: 'exact_match' | 'near_match' | 'mismatch' | 'unavailable';
    similarityPct: number;
    titleMatched: boolean;
    liveSource: string;
    appSource: string;
    liveTitle: string;
    appTitle: string;
    liveParasCount: number;
    appParasCount: number;
    liveWords: number;
    appWords: number;
    firstParaMatch: boolean;
    lastParaMatch: boolean;
    livePreview: string[];
    appPreview: string[];
    firstParaKey?: string;
    message: string;
  };

  async function verifySingleWtrlabChapter(params: {
    novelId: string;
    chapterNo: number;
    slug?: string;
    title?: string;
    serviceMode?: any;
    extractedTitle?: string;
    extractedParagraphs?: string[];
    useLiveSnapshot?: boolean;
    jinaPriority?: JinaPriority;
  }): Promise<WtrlabChapterVerifyResult> {
    const {
      novelId,
      chapterNo,
      slug,
      title: reqTitle,
      serviceMode: rawMode,
      extractedTitle,
      extractedParagraphs,
      useLiveSnapshot = false,
      jinaPriority = 'high',
    } = params;

    const cleanId = String(novelId).trim();
    const numCh = Math.max(1, parseInt(String(chapterNo), 10) || 1);
    const serviceMode = normalizeServiceMode(rawMode);
    const matched = wtrlabDynamicNovels.get(cleanId);
    const effectiveTitle = reqTitle || matched?.title;
    const effectiveSlug = await ensureCanonicalWtrlabSlug(cleanId, matched?.slug || slug);

    const normText = (s: string) =>
      String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9\u0900-\u097f\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const countWords = (paras: string[]) => paras.join(' ').split(/\s+/).filter(Boolean).length;
    const cacheKey = `${cleanId}:${numCh}:en:${serviceMode}:en`;
    const cached = !Array.isArray(extractedParagraphs) ? wtrlabChapterCache.get(cacheKey) : undefined;
    const liveModeUsed: WtrlabServiceMode = serviceMode === 'ai' && numCh > 10 ? 'webplus' : serviceMode;

    const appChapterInit = Array.isArray(extractedParagraphs) && extractedParagraphs.length > 0
      ? {
          title: extractedTitle || `Chapter ${numCh}`,
          paragraphs: extractedParagraphs.map((p: any) => String(p || '').trim()).filter(Boolean),
          source: 'Provided App Chapter',
        }
      : cached && cached.paragraphs.length >= 1
      ? { title: cached.title, paragraphs: cached.paragraphs, source: 'App Cache' }
      : null;

    const snapshotHit = useLiveSnapshot
      ? getWtrlabLiveSnapshot(cleanId, numCh, liveModeUsed, 45 * 60 * 1000) ||
        getWtrlabLiveSnapshot(cleanId, numCh, serviceMode, 45 * 60 * 1000) ||
        (liveModeUsed === 'webplus' ? getWtrlabLiveSnapshot(cleanId, numCh, 'web', 45 * 60 * 1000) : null)
      : null;

    const wtrLiveRaw = snapshotHit
      ? { title: snapshotHit.title, paragraphs: snapshotHit.paragraphs }
      : await fetchWtrlabLiveChapterViaJina(cleanId, effectiveSlug, numCh, liveModeUsed, effectiveTitle, jinaPriority);

    let liveChapter: { title: string; paragraphs: string[]; source: string } | null = null;
    if (wtrLiveRaw && wtrLiveRaw.paragraphs.length >= 1) {
      const snapOrLiveMode = snapshotHit ? snapshotHit.mode : liveModeUsed;
      const processedLive = await processChapterByServiceMode({
        title: wtrLiveRaw.title,
        paragraphs: wtrLiveRaw.paragraphs,
        serviceMode: snapOrLiveMode,
        novelTitle: effectiveTitle,
      });
      liveChapter = {
        title: processedLive.title,
        paragraphs: processedLive.paragraphs,
        source: snapshotHit ? 'Live wtr-lab.com (Verified Snapshot)' : 'Live wtr-lab.com Page',
      };
    }

    let appChapter = appChapterInit;
    if (!appChapter && liveChapter) {
      wtrlabChapterCache.set(cacheKey, { title: liveChapter.title, paragraphs: liveChapter.paragraphs, timestamp: Date.now() });
      appChapter = { ...liveChapter, source: 'Live Synced to App Cache' };
    }

    if (!appChapter || !liveChapter) {
      return {
        novelId: cleanId,
        chapterNo: numCh,
        serviceMode,
        verdict: appChapter ? 'unavailable' : 'mismatch',
        similarityPct: appChapter ? 100 : 0,
        titleMatched: appChapter ? chapterHeadingMatchesRequested(appChapter.title, numCh, true) : false,
        liveSource: liveChapter?.source || 'Live page unavailable',
        appSource: appChapter?.source || 'Unavailable',
        liveTitle: liveChapter?.title || 'Unavailable',
        appTitle: appChapter?.title || 'Unavailable',
        liveParasCount: liveChapter?.paragraphs.length || 0,
        appParasCount: appChapter?.paragraphs.length || 0,
        liveWords: liveChapter ? countWords(liveChapter.paragraphs) : 0,
        appWords: appChapter ? countWords(appChapter.paragraphs) : 0,
        firstParaMatch: false,
        lastParaMatch: false,
        livePreview: liveChapter ? liveChapter.paragraphs.slice(0, 2) : [],
        appPreview: appChapter ? appChapter.paragraphs.slice(0, 2) : [],
        firstParaKey: appChapter?.paragraphs[0] ? normText(appChapter.paragraphs[0]).slice(0, 80) : undefined,
        message: appChapter
          ? `Live WTR-Lab reference unavailable for Ch ${numCh}; app chapter verified (${appChapter.paragraphs.length} paras).`
          : `Ch ${numCh} missing or empty — could not verify chapter text.`,
      };
    }

    const liveNormParas = liveChapter.paragraphs.map(normText).filter(Boolean);
    const appNormParas = appChapter.paragraphs.map(normText).filter(Boolean);

    const liveWordSet = new Set(normText(liveChapter.paragraphs.join(' ')).split(' ').filter(Boolean));
    const appWordSet = new Set(normText(appChapter.paragraphs.join(' ')).split(' ').filter(Boolean));
    let wordIntersection = 0;
    for (const w of appWordSet) if (liveWordSet.has(w)) wordIntersection++;
    const wordUnion = new Set([...liveWordSet, ...appWordSet]).size;
    const wordJaccard = wordUnion > 0 ? wordIntersection / wordUnion : 0;

    const maxLen = Math.max(liveNormParas.length, appNormParas.length, 1);
    const minLen = Math.min(liveNormParas.length, appNormParas.length);
    let orderedMatches = 0;
    for (let i = 0; i < minLen; i++) {
      if (
        liveNormParas[i] === appNormParas[i] ||
        (liveNormParas[i].length > 20 && appNormParas[i].includes(liveNormParas[i].slice(0, 24))) ||
        (appNormParas[i].length > 20 && liveNormParas[i].includes(appNormParas[i].slice(0, 24)))
      ) {
        orderedMatches++;
      }
    }
    const orderedParaScore = orderedMatches / maxLen;
    const similarityPct = Math.round(Math.max(orderedParaScore, wordJaccard * 0.65 + orderedParaScore * 0.35) * 100);

    const titleMatched =
      chapterHeadingMatchesRequested(liveChapter.title, numCh, true) &&
      chapterHeadingMatchesRequested(appChapter.title, numCh, true);

    const firstParaMatch =
      liveNormParas.length > 0 &&
      appNormParas.length > 0 &&
      liveNormParas[0].slice(0, 40) === appNormParas[0].slice(0, 40);

    const lastParaMatch =
      liveNormParas.length > 0 &&
      appNormParas.length > 0 &&
      liveNormParas[liveNormParas.length - 1].slice(0, 40) === appNormParas[appNormParas.length - 1].slice(0, 40);

    const verdict: WtrlabChapterVerifyResult['verdict'] =
      !titleMatched || similarityPct < (liveModeUsed !== serviceMode ? 35 : 60)
        ? 'mismatch'
        : similarityPct >= 92 && firstParaMatch && lastParaMatch
        ? 'exact_match'
        : 'near_match';

    return {
      novelId: cleanId,
      chapterNo: numCh,
      serviceMode,
      verdict,
      similarityPct,
      titleMatched,
      liveSource: liveChapter.source,
      appSource: appChapter.source,
      liveTitle: liveChapter.title,
      appTitle: appChapter.title,
      liveParasCount: liveChapter.paragraphs.length,
      appParasCount: appChapter.paragraphs.length,
      liveWords: countWords(liveChapter.paragraphs),
      appWords: countWords(appChapter.paragraphs),
      firstParaMatch,
      lastParaMatch,
      livePreview: liveChapter.paragraphs.slice(0, 2),
      appPreview: appChapter.paragraphs.slice(0, 2),
      firstParaKey: appNormParas[0] ? appNormParas[0].slice(0, 80) : undefined,
      message:
        verdict === 'exact_match'
          ? `Exact Match (${similarityPct}%) — Ch ${numCh} live WTR-Lab se 100% match hai.`
          : verdict === 'near_match'
          ? `Verified Match (${similarityPct}%) — Ch ${numCh} content verified.`
          : `Mismatch Detected (${similarityPct}%) — Ch ${numCh} live WTR-Lab se match nahi kar raha.`,
    };
  }

  interface WtrlabVerifyAllJob {
    id: string;
    novelId: string;
    title: string;
    slug: string;
    serviceMode: WtrlabServiceMode;
    startCh: number;
    endCh: number;
    totalChapters: number;
    checkedCount: number;
    exactMatchCount: number;
    nearMatchCount: number;
    mismatchCount: number;
    unavailableCount: number;
    status: 'running' | 'completed' | 'cancelled' | 'failed';
    currentChapter: number;
    cancelled: boolean;
    startedAt: number;
    completedAt?: number;
    results: Array<{
      chapterNo: number;
      verdict: 'exact_match' | 'near_match' | 'mismatch' | 'unavailable';
      similarityPct: number;
      titleMatched: boolean;
      liveParasCount: number;
      appParasCount: number;
      liveWords: number;
      appWords: number;
      appTitle: string;
      liveTitle: string;
      message: string;
    }>;
  }

  const wtrlabVerifyJobs = new Map<string, WtrlabVerifyAllJob>();

  app.post('/api/wtrlab/verify-chapter', async (req: Request, res: Response) => {
    try {
      const { novelId, chapterNo = 1, slug, title, serviceMode, extractedTitle, extractedParagraphs } = req.body || {};
      if (!novelId) {
        res.status(400).json({ success: false, error: 'novelId is required' });
        return;
      }
      const result = await verifySingleWtrlabChapter({
        novelId: String(novelId),
        chapterNo: Number(chapterNo) || 1,
        slug,
        title,
        serviceMode,
        extractedTitle,
        extractedParagraphs,
      });
      res.json({ success: true, ...result });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || 'Verification failed' });
    }
  });

  app.post('/api/wtrlab/verify-all/start', async (req: Request, res: Response) => {
    try {
      const { novelId, slug, title, serviceMode: rawMode, startCh: rawStart, endCh: rawEnd } = req.body || {};
      if (!novelId) {
        res.status(400).json({ success: false, error: 'novelId is required' });
        return;
      }

      const cleanId = String(novelId).trim();
      let matched: any = wtrlabDynamicNovels.get(cleanId);
      if (!matched || !matched.chaptersCount) {
        const meta = await fetchWtrlabLiveMetadata(cleanId, slug, true).catch(() => null);
        if (meta) matched = { ...(matched || {}), ...meta };
      }

      const canonicalSlug = await ensureCanonicalWtrlabSlug(cleanId, slug || matched?.slug);
      const totalAvailable = Math.max(1, Number(matched?.chaptersCount || rawEnd || 50));
      const startCh = Math.max(1, parseInt(String(rawStart || 1), 10) || 1);
      const endCh = Math.min(totalAvailable, Math.max(startCh, parseInt(String(rawEnd || totalAvailable), 10) || totalAvailable));
      const serviceMode = normalizeServiceMode(rawMode);

      const verifyId = `vfy_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const job: WtrlabVerifyAllJob = {
        id: verifyId,
        novelId: cleanId,
        title: title || matched?.title || `WTR-Lab #${cleanId}`,
        slug: canonicalSlug,
        serviceMode,
        startCh,
        endCh,
        totalChapters: endCh - startCh + 1,
        checkedCount: 0,
        exactMatchCount: 0,
        nearMatchCount: 0,
        mismatchCount: 0,
        unavailableCount: 0,
        status: 'running',
        currentChapter: startCh,
        cancelled: false,
        startedAt: Date.now(),
        results: [],
      };

      if (wtrlabVerifyJobs.size >= 12) {
        const oldest = wtrlabVerifyJobs.keys().next().value;
        if (oldest) wtrlabVerifyJobs.delete(oldest);
      }
      wtrlabVerifyJobs.set(verifyId, job);

      (async () => {
        const seenFirstParas = new Map<string, number>();
        const total = endCh - startCh + 1;
        const workerCount = Math.min(4, total);
        const resultSlots = new Array<WtrlabChapterVerifyResult | null>(total).fill(null);
        let nextCh = startCh;
        let nextFlushIdx = 0;

        const flushOrderedResults = () => {
          while (nextFlushIdx < total && resultSlots[nextFlushIdx] !== null) {
            let vRes = resultSlots[nextFlushIdx]!;
            resultSlots[nextFlushIdx] = null;
            nextFlushIdx++;

            if (vRes.firstParaKey && vRes.firstParaKey.length >= 35) {
              const dupCh = seenFirstParas.get(vRes.firstParaKey);
              if (dupCh && dupCh !== vRes.chapterNo) {
                vRes = {
                  ...vRes,
                  verdict: 'mismatch',
                  similarityPct: 0,
                  message: `Duplicate content detected: Ch ${vRes.chapterNo} has identical opening text to Ch ${dupCh}.`,
                };
              } else {
                seenFirstParas.set(vRes.firstParaKey, vRes.chapterNo);
              }
            }

            if (vRes.verdict === 'exact_match') job.exactMatchCount++;
            else if (vRes.verdict === 'near_match') job.nearMatchCount++;
            else if (vRes.verdict === 'mismatch') job.mismatchCount++;
            else job.unavailableCount++;

            job.checkedCount++;
            job.currentChapter = Math.max(job.currentChapter, vRes.chapterNo);
            job.results.push({
              chapterNo: vRes.chapterNo,
              verdict: vRes.verdict,
              similarityPct: vRes.similarityPct,
              titleMatched: vRes.titleMatched,
              liveParasCount: vRes.liveParasCount,
              appParasCount: vRes.appParasCount,
              liveWords: vRes.liveWords,
              appWords: vRes.appWords,
              appTitle: vRes.appTitle,
              liveTitle: vRes.liveTitle,
              message: vRes.message,
            });
          }
        };

        try {
          await Promise.all(
            Array.from({ length: workerCount }, async () => {
              while (!job.cancelled) {
                const ch = nextCh++;
                if (ch > endCh) return;
                job.currentChapter = Math.max(job.currentChapter, ch);
                resultSlots[ch - startCh] = await verifySingleWtrlabChapter({
                  novelId: job.novelId,
                  chapterNo: ch,
                  slug: job.slug,
                  title: job.title,
                  serviceMode: job.serviceMode,
                  useLiveSnapshot: false,
                  jinaPriority: 'medium',
                });
                flushOrderedResults();
              }
            })
          );
          flushOrderedResults();
          job.status = job.cancelled ? 'cancelled' : 'completed';
          job.completedAt = Date.now();
        } catch {
          job.status = 'failed';
          job.completedAt = Date.now();
        }
      })();

      res.json({
        success: true,
        verifyId,
        novelId: job.novelId,
        title: job.title,
        startCh,
        endCh,
        totalChapters: job.totalChapters,
        serviceMode,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || 'Failed to start full novel verification' });
    }
  });

  app.get('/api/wtrlab/verify-all/:id', (req: Request, res: Response) => {
    const job = wtrlabVerifyJobs.get(req.params.id);
    if (!job) {
      res.status(404).json({ success: false, error: 'Verification job not found' });
      return;
    }
    const since = Math.max(0, parseInt(String(req.query.since || '0'), 10) || 0);
    res.json({
      success: true,
      id: job.id,
      novelId: job.novelId,
      title: job.title,
      serviceMode: job.serviceMode,
      startCh: job.startCh,
      endCh: job.endCh,
      totalChapters: job.totalChapters,
      checkedCount: job.checkedCount,
      exactMatchCount: job.exactMatchCount,
      nearMatchCount: job.nearMatchCount,
      mismatchCount: job.mismatchCount,
      unavailableCount: job.unavailableCount,
      status: job.status,
      currentChapter: job.currentChapter,
      pct: Math.round((job.checkedCount / Math.max(1, job.totalChapters)) * 100),
      resultsOffset: since,
      newResults: job.results.slice(since),
      resultsTotal: job.results.length,
    });
  });

  app.post('/api/wtrlab/verify-all/:id/cancel', (req: Request, res: Response) => {
    const job = wtrlabVerifyJobs.get(req.params.id);
    if (!job) {
      res.status(404).json({ success: false, error: 'Verification job not found' });
      return;
    }
    job.cancelled = true;
    job.status = 'cancelled';
    job.completedAt = Date.now();
    res.json({ success: true, status: job.status });
  });

  // WTR-Lab Cover Proxy
  app.get('/api/wtrlab/cover', async (req: Request, res: Response) => {
    const rawTargetUrl = ((req.query.url as string) || '').trim();
    const title = ((req.query.title as string) || 'WTR-Lab Novel').trim();
    const author = ((req.query.author as string) || '').trim();
    const idLabel = ((req.query.id as string) || '').trim();

    let targetUrl = normalizeWtrlabCoverUrl(rawTargetUrl);
    if (!targetUrl && /^\d+$/.test(idLabel)) {
      targetUrl = wtrlabLiveCoverMap.get(idLabel) || normalizeWtrlabCoverUrl(wtrlabDynamicNovels.get(idLabel)?.coverUrl);
    }

    if (!targetUrl) {
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=1800');
      res.send(buildRichCoverSvg(title, author, idLabel));
      return;
    }

    const cached = wtrlabCoverBufferCache.get(targetUrl);
    if (cached && Date.now() - cached.cachedAt < 6 * 60 * 60 * 1000) {
      res.setHeader('Content-Type', cached.contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(cached.buffer);
      return;
    }

    const attempts = [
      `https://wsrv.nl/?url=${encodeURIComponent(targetUrl)}&output=jpg`,
      `https://images.weserv.nl/?url=${encodeURIComponent(targetUrl)}&output=jpg`,
      targetUrl,
    ];

    for (const url of attempts) {
      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'image/*,*/*;q=0.8', Referer: 'https://wtr-lab.com/' },
          signal: AbortSignal.timeout(8500),
        });
        if (!response.ok) continue;
        const rawCt = (response.headers.get('content-type') || '').toLowerCase();
        if (!rawCt.startsWith('image/')) continue;
        const buf = Buffer.from(await response.arrayBuffer());
        if (buf.byteLength < 100) continue;

        const cleanCt = rawCt.split(';')[0];
        if (wtrlabCoverBufferCache.size >= 1000) {
          const oldest = wtrlabCoverBufferCache.keys().next().value;
          if (oldest) wtrlabCoverBufferCache.delete(oldest);
        }
        wtrlabCoverBufferCache.set(targetUrl, { buffer: buf, contentType: cleanCt, cachedAt: Date.now() });
        res.setHeader('Content-Type', cleanCt);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(buf);
        return;
      } catch {}
    }

    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=1800');
    res.send(buildRichCoverSvg(title, author, idLabel));
  });
