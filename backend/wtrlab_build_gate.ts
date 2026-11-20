    private async verifyAndRepairBuiltChapters(params: {
      job: ScrapeJob;
      builtChapters: Array<{
        num: number;
        title: string;
        paragraphs: string[];
        url: string;
        sourceEnTitle?: string;
        sourceEnParagraphs?: string[];
        origin?: string;
        isOmittedFallback?: boolean;
        upstreamVerifiedLive?: boolean;
      }>;
      platformName: string;
      matchedSlug: string;
      jobServiceMode: WtrlabServiceMode;
      targetLang: 'en' | 'hi';
      isWtrlab: boolean;
      isFanmtl: boolean;
      tocChapterUrls?: Map<number, string>;
    }): Promise<{
      passedAll: boolean;
      anyRepaired: boolean;
      failedDetails: Array<{ ch: number; reason: string }>;
      summary: JobBuildVerificationSummary;
    }> {
      const {
        job,
        builtChapters,
        platformName,
        matchedSlug,
        jobServiceMode,
        targetLang,
        isWtrlab,
      } = params;
      const stats = this.ensureBuildStats(job);
      job.status = 'verifying';
      const totalRequested = Math.max(1, job.totalChapters - job.startChapter + 1);

      // Ensure real canonical slug is resolved so repair/verification never triggers WTR-Lab slug-redirect chapter shifts!
      const canonicalSlug = isWtrlab
        ? await ensureCanonicalWtrlabSlug(String(job.novelId), matchedSlug)
        : matchedSlug;

      this.pushJobLog(
        job,
        'info',
        'verify',
        `Post-Build Verification Gate started: auditing ALL ${builtChapters.length}/${totalRequested} chapter(s) before delivery...`
      );
      if (job.chatId && job.botToken && job.telegramMessageId) {
        await editTelegramMessage(
          job.botToken,
          job.chatId,
          job.telegramMessageId,
          `🔍 <b>Verifying All ${builtChapters.length} Chapters...</b>\n` +
            `📖 <b>${escapeXml(job.title)}</b>\n` +
            `Checking sequence, zero-duplicates, &amp; live ${escapeXml(platformName)} parity.`
        ).catch(() => {});
      }

      const byNum = new Map<number, (typeof builtChapters)[number]>();
      for (const ch of builtChapters) byNum.set(ch.num, ch);

      const seenFullHashes = new Map<string, number>();
      const seenOpeningKeys = new Map<string, number>();
      const seenSecondKeys = new Map<string, number>();
      const seenTitles = new Map<string, number>();

      const failedDetails: Array<{ ch: number; reason: string }> = [];
      let exactCount = 0;
      let nearCount = 0;
      let repairedCount = 0;
      let mismatchCount = 0;
      let missingCount = 0;
      let duplicateCount = 0;
      let unavailableCount = 0;
      let anyRepaired = false;

      const invalidateSnapshotsForCh = (chNo: number) => {
        if (!isWtrlab) return;
        for (const m of ['web', 'webplus', 'ai'] as WtrlabServiceMode[]) {
          wtrlabLiveSnapshotCache.delete(`${job.novelId}:${chNo}:${m}`);
          wtrlabChapterCache.delete(`${job.novelId}:${chNo}:en:${m}:en`);
          wtrlabChapterCache.delete(`${job.novelId}:${chNo}:${targetLang}:${m}:${targetLang === 'hi' ? 'auto' : 'en'}`);
        }
      };

      // Pass 1: Concurrent Parity & Intra-Chapter Cleanup Check
      type SlotPreCheck = {
        expectedCh: number;
        ch?: (typeof builtChapters)[number];
        checkTitle: string;
        checkParas: string[];
        isPlaceholder: boolean;
        headingOk: boolean;
        fullHash: string;
        openingKey: string;
        secondKey: string;
        normTitle: string;
        isNumberedTitle: boolean;
        wtrVerdict: WtrlabChapterVerifyResult | null;
      };
      const slotPreChecks = new Array<SlotPreCheck>(totalRequested);
      let nextAuditCh = job.startChapter;
      const auditConcurrency = Math.min(4, totalRequested);

      await Promise.all(
        Array.from({ length: auditConcurrency }, async () => {
          while (nextAuditCh <= job.totalChapters) {
            if (this.cancelled.has(job.id)) return;
            const expectedCh = nextAuditCh++;
            const idx = expectedCh - job.startChapter;
            const ch = byNum.get(expectedCh);
            if (!ch) {
              slotPreChecks[idx] = {
                expectedCh,
                checkTitle: '',
                checkParas: [],
                isPlaceholder: true,
                headingOk: false,
                fullHash: '',
                openingKey: '',
                secondKey: '',
                normTitle: '',
                isNumberedTitle: false,
                wtrVerdict: null,
              };
              continue;
            }

            // Guarantee intra-chapter paragraph deduplication
            ch.paragraphs = deduplicateChapterParagraphs(ch.paragraphs);
            if (Array.isArray(ch.sourceEnParagraphs)) {
              ch.sourceEnParagraphs = deduplicateChapterParagraphs(ch.sourceEnParagraphs);
            }

            const checkTitle = isWtrlab
              ? normalizeWtrlabSlotTitle(ch.sourceEnTitle || ch.title, expectedCh)
              : (ch.sourceEnTitle || ch.title);
            const checkParas =
              Array.isArray(ch.sourceEnParagraphs) && ch.sourceEnParagraphs.length > 0
                ? ch.sourceEnParagraphs
                : ch.paragraphs;
            const isPlaceholder =
              Boolean(ch.isOmittedFallback) ||
              this.isPlaceholderChapter(ch.paragraphs) ||
              this.isPlaceholderChapter(checkParas);
            const headingOk = chapterHeadingMatchesRequested(checkTitle, expectedCh, true);
            const fp = computeChapterFingerprint(checkParas);
            const normTitle = checkTitle.toLowerCase().replace(/\s+/g, ' ').trim();
            const isNumberedTitle = /^(?:chapter|ch\.?)\s*\d+/i.test(normTitle);

            let wtrVerdict: WtrlabChapterVerifyResult | null = null;
            if (isWtrlab && !isPlaceholder) {
              wtrVerdict = await verifySingleWtrlabChapter({
                novelId: job.novelId,
                chapterNo: expectedCh,
                slug: canonicalSlug,
                title: job.title,
                serviceMode: jobServiceMode,
                extractedTitle: checkTitle,
                extractedParagraphs: checkParas,
                useLiveSnapshot: true,
              });
            }

            slotPreChecks[idx] = {
              expectedCh,
              ch,
              checkTitle,
              checkParas,
              isPlaceholder,
              headingOk,
              fullHash: fp.fullHash,
              openingKey: fp.openingKey,
              secondKey: fp.secondKey,
              normTitle,
              isNumberedTitle,
              wtrVerdict,
            };
          }
        })
      );

      // Pass 2A: Deterministic In-Order Scan — Flag Missing, Mismatched, or Duplicate Chapters (+ Earlier Partner!)
      type FlaggedTask = {
        expectedCh: number;
        ch: (typeof builtChapters)[number];
        reason: string;
        isPlaceholder: boolean;
        isDuplicate: boolean;
      };
      const flaggedTasks: FlaggedTask[] = [];
      const flaggedSet = new Set<number>();
      const acceptedSlots = new Map<number, { expectedCh: number; ch: (typeof builtChapters)[number]; wtrVerdict: WtrlabChapterVerifyResult | null }>();

      for (let idx = 0; idx < slotPreChecks.length; idx++) {
        if (this.cancelled.has(job.id)) break;
        const slot = slotPreChecks[idx];
        const expectedCh = slot ? slot.expectedCh : job.startChapter + idx;
        const ch = slot?.ch;

        if (!ch || !slot) {
          missingCount++;
          const msg = `Chapter slot missing from built novel (expected Ch ${expectedCh})`;
          failedDetails.push({ ch: expectedCh, reason: msg });
          this.pushJobLog(job, 'error', 'verify', msg, expectedCh);
          continue;
        }

        const dupPartner =
          (slot.fullHash ? seenFullHashes.get(slot.fullHash) : undefined) ||
          (slot.openingKey.length >= 42 ? seenOpeningKeys.get(slot.openingKey) : undefined) ||
          (slot.secondKey.length >= 48 ? seenSecondKeys.get(slot.secondKey) : undefined) ||
          (slot.isNumberedTitle && slot.normTitle.length > 14 ? seenTitles.get(slot.normTitle) : undefined);

        const isDuplicate = Boolean(dupPartner && dupPartner !== expectedCh);
        const issueReason = slot.isPlaceholder
          ? 'Missing/placeholder chapter body'
          : !slot.headingOk
          ? `Wrong chapter heading ("${slot.checkTitle}" for Ch ${expectedCh})`
          : isDuplicate
          ? `Duplicate chapter content matches Ch ${dupPartner}`
          : slot.wtrVerdict?.verdict === 'mismatch'
          ? `Live ${platformName} mismatch (${slot.wtrVerdict.similarityPct}% parity)`
          : '';

        if (issueReason) {
          if (!flaggedSet.has(expectedCh)) {
            flaggedSet.add(expectedCh);
            invalidateSnapshotsForCh(expectedCh);
            flaggedTasks.push({
              expectedCh,
              ch,
              reason: issueReason,
              isPlaceholder: slot.isPlaceholder,
              isDuplicate,
            });
          }
          if (dupPartner && dupPartner !== expectedCh && !flaggedSet.has(dupPartner)) {
            const partner = acceptedSlots.get(dupPartner);
            if (partner) {
              acceptedSlots.delete(dupPartner);
              flaggedSet.add(dupPartner);
              invalidateSnapshotsForCh(dupPartner);
              flaggedTasks.push({
                expectedCh: dupPartner,
                ch: partner.ch,
                reason: `Duplicate partner with Ch ${expectedCh} — fresh canonical re-fetch`,
                isPlaceholder: false,
                isDuplicate: true,
              });
            }
          }
        } else {
          if (slot.fullHash) seenFullHashes.set(slot.fullHash, expectedCh);
          if (slot.openingKey.length >= 42) seenOpeningKeys.set(slot.openingKey, expectedCh);
          if (slot.secondKey.length >= 48) seenSecondKeys.set(slot.secondKey, expectedCh);
          if (slot.isNumberedTitle && slot.normTitle.length > 14) seenTitles.set(slot.normTitle, expectedCh);
          acceptedSlots.set(expectedCh, { expectedCh, ch, wtrVerdict: slot.wtrVerdict });
        }
      }

      for (const fNum of flaggedSet) {
        for (const [k, v] of seenFullHashes.entries()) if (v === fNum) seenFullHashes.delete(k);
        for (const [k, v] of seenOpeningKeys.entries()) if (v === fNum) seenOpeningKeys.delete(k);
        for (const [k, v] of seenSecondKeys.entries()) if (v === fNum) seenSecondKeys.delete(k);
        for (const [k, v] of seenTitles.entries()) if (v === fNum) seenTitles.delete(k);
      }

      for (const acc of acceptedSlots.values()) {
        if (acc.wtrVerdict?.verdict === 'near_match') nearCount++;
        else if (acc.wtrVerdict?.verdict === 'unavailable') unavailableCount++;
        else exactCount++;
      }

      // Pass 2B: Concurrent Repair Pool using Canonical Slug & Clean Scraper
      if (flaggedTasks.length > 0 && !this.cancelled.has(job.id)) {
        let cursor = 0;
        const workers = Math.min(3, flaggedTasks.length);

        await Promise.all(
          Array.from({ length: workers }, async () => {
            while (cursor < flaggedTasks.length) {
              if (this.cancelled.has(job.id)) return;
              const task = flaggedTasks[cursor++];
              const { expectedCh, ch, reason, isPlaceholder, isDuplicate } = task;
              this.pushJobLog(job, 'retry', 'verify', `Repairing Ch ${expectedCh} (${reason})...`, expectedCh);

              let repairedOk = false;
              for (let attempt = 1; attempt <= 3 && !repairedOk && !this.cancelled.has(job.id); attempt++) {
                if (attempt > 1) await new Promise((r) => setTimeout(r, 900 * attempt));
                invalidateSnapshotsForCh(expectedCh);

                const tryMode: WtrlabServiceMode =
                  attempt === 2
                    ? (jobServiceMode === 'web' ? 'webplus' : 'web')
                    : jobServiceMode;

                const fresh = isWtrlab
                  ? await scrapeWtrlabChapterClean({
                      novelId: job.novelId,
                      slug: canonicalSlug,
                      chapterNo: expectedCh,
                      serviceMode: tryMode,
                      language: 'en',
                      novelTitle: job.title,
                      skipCache: true,
                      priority: 'high',
                      timeoutMs: 19000,
                    })
                  : null;

                if (!fresh && isJinaUrlKnown404(`https://wtr-lab.com/en/novel/${job.novelId}/${canonicalSlug}/chapter-${expectedCh}`)) {
                  break;
                }
                if (!fresh || fresh.paragraphs.length < 2) continue;

                const processed = await processChapterByServiceMode({
                  title: normalizeWtrlabSlotTitle(fresh.title, expectedCh),
                  paragraphs: fresh.paragraphs,
                  serviceMode: jobServiceMode,
                  novelTitle: job.title,
                });

                const fp = computeChapterFingerprint(processed.paragraphs);
                const collidingCh =
                  (fp.fullHash ? seenFullHashes.get(fp.fullHash) : undefined) ||
                  (fp.openingKey.length >= 42 ? seenOpeningKeys.get(fp.openingKey) : undefined);

                if (collidingCh && collidingCh !== expectedCh) {
                  const partnerCh = byNum.get(collidingCh);
                  if (attempt >= 2 && partnerCh) {
                    ch.upstreamVerifiedLive = true;
                    partnerCh.upstreamVerifiedLive = true;
                  } else {
                    continue;
                  }
                }

                let finalTitle = processed.title;
                let finalParas = processed.paragraphs;
                if (targetLang === 'hi' && finalParas.some((p) => hasEnglishLeakage(p))) {
                  const activeEngine = loadBotConfig().translationEngine === 'gemini' ? 'gemini' : 'google';
                  const hi = await translateParagraphsToHindi(finalParas, expectedCh, finalTitle, job.novelId || job.title, activeEngine);
                  finalTitle = hi.title;
                  finalParas = deduplicateChapterParagraphs(hi.paragraphs);
                }

                ch.title = finalTitle;
                ch.paragraphs = finalParas;
                ch.url = `https://wtr-lab.com/en/novel/${job.novelId}/${canonicalSlug}/chapter-${expectedCh}`;
                ch.sourceEnTitle = processed.title;
                ch.sourceEnParagraphs = processed.paragraphs;
                if (ch.isOmittedFallback || isPlaceholder) {
                  ch.isOmittedFallback = false;
                  if (stats.placeholderCount > 0) stats.placeholderCount -= 1;
                  stats.verifiedCount += 1;
                }

                if (fp.fullHash) seenFullHashes.set(fp.fullHash, expectedCh);
                if (fp.openingKey.length >= 42) seenOpeningKeys.set(fp.openingKey, expectedCh);
                if (fp.secondKey.length >= 48) seenSecondKeys.set(fp.secondKey, expectedCh);

                const cacheKey = `${job.novelId}:${expectedCh}:${targetLang}:${jobServiceMode}:${targetLang === 'hi' ? 'auto' : 'en'}`;
                wtrlabChapterCache.set(cacheKey, { title: finalTitle, paragraphs: finalParas, timestamp: Date.now() });

                anyRepaired = true;
                repairedCount++;
                exactCount++;
                repairedOk = true;
                this.pushJobLog(job, 'ok', 'verify', `Repaired & verified Ch ${expectedCh}: "${finalTitle}"`, expectedCh);
              }

              if (!repairedOk) {
                if (isPlaceholder) missingCount++;
                else if (isDuplicate) duplicateCount++;
                else mismatchCount++;
                failedDetails.push({ ch: expectedCh, reason });
                this.pushJobLog(job, 'error', 'verify', `FAILED GATE Ch ${expectedCh}: ${reason}`, expectedCh);
              }
            }
          })
        );
      }

      // Pass 3: Final Post-Repair Global Zero-Duplicate Audit
      const auditHashes = new Map<string, number>();
      const auditOpenings = new Map<string, number>();
      for (let chNo = job.startChapter; chNo <= job.totalChapters; chNo++) {
        const ch = byNum.get(chNo);
        if (!ch || failedDetails.some((f) => f.ch === chNo)) continue;
        const pList = Array.isArray(ch.sourceEnParagraphs) && ch.sourceEnParagraphs.length > 0 ? ch.sourceEnParagraphs : ch.paragraphs;
        const fp = computeChapterFingerprint(pList);
        const owner =
          (fp.fullHash ? auditHashes.get(fp.fullHash) : undefined) ||
          (fp.openingKey.length >= 45 ? auditOpenings.get(fp.openingKey) : undefined);

        if (owner && owner !== chNo && !ch.upstreamVerifiedLive) {
          duplicateCount++;
          if (exactCount > 0) exactCount--;
          const reason = `Global duplicate check blocked: Ch ${chNo} shares identical body with Ch ${owner}`;
          failedDetails.push({ ch: chNo, reason });
          this.pushJobLog(job, 'error', 'verify', reason, chNo);
        } else {
          if (fp.fullHash) auditHashes.set(fp.fullHash, chNo);
          if (fp.openingKey.length >= 45) auditOpenings.set(fp.openingKey, chNo);
        }
      }

      const missingInSequence = Math.max(0, totalRequested - builtChapters.length);
      const summary: JobBuildVerificationSummary = {
        total: totalRequested,
        exact: exactCount,
        near: nearCount,
        repaired: repairedCount,
        mismatch: mismatchCount,
        missing: missingCount + missingInSequence,
        duplicate: duplicateCount,
        unavailable: unavailableCount,
      };
      stats.verificationSummary = summary;

      const passedAll =
        !this.cancelled.has(job.id) &&
        failedDetails.length === 0 &&
        summary.missing === 0 &&
        summary.mismatch === 0 &&
        summary.duplicate === 0 &&
        stats.placeholderCount === 0;

      return { passedAll, anyRepaired, failedDetails, summary };
    }


// --- WTR-Lab Job Execution Loop ---

    private async executeJob(job: ScrapeJob, explicitEndCh?: number, rangeMode?: 'demo' | 'all' | 'custom') {
      const isWtrlabScrapeBuild = job.novelUrl.includes('wtr-lab.com') || /^wtr_/i.test(String(job.novelId));
      if (isWtrlabScrapeBuild) {
        activeWtrlabScrapeJobs++;
        lastInteractiveJinaAt = Date.now();
      }
      try {
        const cleanNovelId = String(job.novelId).replace(/^wtr_/i, '').trim();
        job.novelId = cleanNovelId;

        const urlSlugMatch = job.novelUrl.match(/\/novel\/\d+\/([a-z0-9_-]+)/i);
        const urlSlug = urlSlugMatch?.[1] && !urlSlugMatch[1].startsWith('chapter-') ? urlSlugMatch[1] : undefined;
        let matched: any = wtrlabDynamicNovels.get(cleanNovelId) || wtrlabLiveMetaCache.get(cleanNovelId)?.data || null;

        const hasGenericTitle =
          !matched ||
          !matched.title ||
          Boolean(matched.isPlaceholderIndex) ||
          /^WTR-Lab Novel #?\d+$/i.test(matched.title);
        const isStaleMeta = !matched?.updatedAtMs || (Date.now() - Number(matched.updatedAtMs) > 15 * 60 * 1000);

        if (hasGenericTitle || rangeMode === 'all' || !explicitEndCh || isStaleMeta || !matched?.slug || matched.slug === 'novel') {
          const liveMeta = await fetchWtrlabLiveMetadata(cleanNovelId, urlSlug || matched?.slug, rangeMode === 'all' || isStaleMeta).catch(() => null);
          if (liveMeta) {
            matched = { ...(matched || {}), ...liveMeta, id: cleanNovelId };
          } else if (isJinaUrlKnown404(`https://wtr-lab.com/en/novel/${cleanNovelId}/novel`)) {
            throw new Error(`WTR-Lab novel #${cleanNovelId} was not found (HTTP 404 on wtr-lab.com).`);
          }
        }

        // Resolve canonical slug ONCE upfront before spawning concurrent workers!
        const canonicalSlug = await ensureCanonicalWtrlabSlug(cleanNovelId, matched?.slug || urlSlug);
        job.novelUrl = `https://wtr-lab.com/en/novel/${cleanNovelId}/${canonicalSlug}`;
        job.title = matched?.title || `WTR-Lab Novel #${cleanNovelId}`;
        job.author = matched?.author || 'WTR-Lab Author';
        job.synopsis = matched?.description || '';
        job.coverUrl = wtrlabLiveCoverMap.get(cleanNovelId) || normalizeWtrlabCoverUrl(matched?.coverUrl);
        if (job.coverUrl) warmWtrlabCoverAsync(job.coverUrl);

        const detectedTotal = Number(matched?.chaptersCount || 0) || 128;
        job.totalChapters =
          rangeMode === 'all'
            ? detectedTotal
            : explicitEndCh && explicitEndCh > 0
            ? (Number(matched?.chaptersCount || 0) > 0 ? Math.min(explicitEndCh, detectedTotal) : explicitEndCh)
            : detectedTotal;

        job.status = 'downloading';
        const multiStats = this.ensureBuildStats(job);
        multiStats.totalRequested = Math.max(1, job.totalChapters - job.startChapter + 1);
        multiStats.verifiedCount = 0;
        multiStats.retryCount = 0;
        multiStats.fallbackCount = 0;
        multiStats.placeholderCount = 0;
        multiStats.errorCount = 0;
        multiStats.warnings = [];
        multiStats.errors = [];
        job.currentChapter = Math.max(0, job.startChapter - 1);
        job.progress = 0;

        this.pushJobLog(
          job,
          'ok',
          'inspect',
          `Verified "${job.title}" (Slug: ${canonicalSlug}) · Ch ${job.startChapter}–${job.totalChapters} (${multiStats.totalRequested} chs)`
        );

        if (job.chatId && job.botToken && job.telegramMessageId) {
          const inspectNotice =
            `📖 <b>${escapeXml(job.title)} (WTR-Lab #${cleanNovelId})</b>\n` +
            `✍️ Author: <code>${escapeXml(job.author)}</code>\n` +
            `🌐 Lang: <b>${job.language === 'hi' ? 'Hindi (हिंदी)' : 'English'}</b>\n\n` +
            `📑 Scraping <b>${multiStats.totalRequested} Chapters</b> (${job.startChapter}–${job.totalChapters})...\n` +
            `<code>[░░░░░░░░░░] 0% (0/${multiStats.totalRequested})</code>`;
          await editTelegramMessage(job.botToken, job.chatId, job.telegramMessageId, inspectNotice).catch(() => {});
        }

        const totalCount = Math.max(1, job.totalChapters - job.startChapter + 1);
        const chapters: Array<{
          num: number;
          title: string;
          paragraphs: string[];
          url: string;
          sourceEnTitle?: string;
          sourceEnParagraphs?: string[];
          origin?: string;
          isOmittedFallback?: boolean;
          upstreamVerifiedLive?: boolean;
        }> = new Array(totalCount);

        // Real-time in-flight duplicate tracker during initial download!
        const seenLiveFingerprints = new Map<string, number>();

        let completedCount = 0;
        let lastEditTime = Date.now();
        let nextChapterNum = job.startChapter;
        let consecutivePlaceholderCount = 0;
        let abortDeadSource = false;
        const chConcurrency = Math.min(4, totalCount);
        const jobServiceMode = normalizeServiceMode(job.serviceMode);
        const targetLang = job.language === 'hi' ? 'hi' : 'en';

        await Promise.all(
          Array.from({ length: chConcurrency }, async () => {
            while (nextChapterNum <= job.totalChapters) {
              if (this.cancelled.has(job.id) || abortDeadSource) return;
              const chNum = nextChapterNum++;
              const slotIndex = chNum - job.startChapter;

              const cacheKey = `${cleanNovelId}:${chNum}:${targetLang}:${jobServiceMode}:${targetLang === 'hi' ? 'auto' : 'en'}`;
              const cached = wtrlabChapterCache.get(cacheKey);
              let chTitle = targetLang === 'hi' ? `अध्याय ${chNum}` : `Chapter ${chNum}`;
              let paragraphs: string[] = [];
              let sourceEnTitle: string | undefined;
              let sourceEnParagraphs: string[] | undefined;
              let chapterOrigin = '';

              if (cached && cached.paragraphs.length >= 2 && Date.now() - cached.timestamp < 24 * 60 * 60 * 1000) {
                chTitle = cached.title;
                paragraphs = deduplicateChapterParagraphs(cached.paragraphs);
                chapterOrigin = 'cache';
                if (targetLang === 'en') {
                  sourceEnTitle = chTitle;
                  sourceEnParagraphs = [...paragraphs];
                }
              }

              if (paragraphs.length < 2) {
                let scraped = await scrapeWtrlabChapterClean({
                  novelId: cleanNovelId,
                  slug: canonicalSlug,
                  chapterNo: chNum,
                  serviceMode: jobServiceMode,
                  language: 'en',
                  novelTitle: job.title,
                  priority: 'high',
                });

                // Immediate in-flight duplicate guard: if content collides with an already-downloaded chapter, bypass cache & re-fetch!
                if (scraped && scraped.paragraphs.length >= 2) {
                  const fp = computeChapterFingerprint(scraped.paragraphs);
                  const dupCh = fp.fullHash ? seenLiveFingerprints.get(fp.fullHash) : undefined;
                  if (dupCh && dupCh !== chNum) {
                    multiStats.retryCount += 1;
                    scraped = await scrapeWtrlabChapterClean({
                      novelId: cleanNovelId,
                      slug: canonicalSlug,
                      chapterNo: chNum,
                      serviceMode: jobServiceMode === 'web' ? 'webplus' : jobServiceMode,
                      language: 'en',
                      novelTitle: job.title,
                      skipCache: true,
                      priority: 'high',
                      timeoutMs: 19000,
                    });
                  }
                }

                if (scraped && scraped.paragraphs.length >= 2) {
                  const processed = await processChapterByServiceMode({
                    title: scraped.title,
                    paragraphs: scraped.paragraphs,
                    serviceMode: jobServiceMode,
                    novelTitle: job.title,
                  });
                  chTitle = processed.title;
                  paragraphs = processed.paragraphs;
                  sourceEnTitle = processed.title;
                  sourceEnParagraphs = [...processed.paragraphs];
                  chapterOrigin = scraped.origin;

                  const fp = computeChapterFingerprint(paragraphs);
                  if (fp.fullHash && !seenLiveFingerprints.has(fp.fullHash)) {
                    seenLiveFingerprints.set(fp.fullHash, chNum);
                  }
                }
              }

              const isPlaceholder = paragraphs.length < 2;
              if (isPlaceholder) {
                chTitle = `Chapter ${chNum}`;
                paragraphs = [
                  `[Chapter ${chNum} of "${job.title}" could not be retrieved on initial pass — queued for verification repair.]`,
                ];
                multiStats.placeholderCount += 1;
                consecutivePlaceholderCount += 1;
                this.pushJobLog(job, 'warn', 'fetch', `Initial fetch missed Ch ${chNum} — queued for repair pass.`, chNum);

                const isKnown404 = isJinaUrlKnown404(`https://wtr-lab.com/en/novel/${cleanNovelId}/${canonicalSlug}/chapter-${chNum}`);
                if (
                  (multiStats.verifiedCount === 0 && consecutivePlaceholderCount >= (isKnown404 ? 4 : 10)) ||
                  consecutivePlaceholderCount >= 20
                ) {
                  abortDeadSource = true;
                  this.pushJobLog(job, 'error', 'fetch', `Aborting early: ${consecutivePlaceholderCount} consecutive chapters failed/404.`, chNum);
                }
              } else {
                consecutivePlaceholderCount = 0;
                if (targetLang === 'hi' && paragraphs.some((p) => hasEnglishLeakage(p))) {
                  const activeEngine = loadBotConfig().translationEngine === 'gemini' ? 'gemini' : 'google';
                  const translated = await translateParagraphsToHindi(paragraphs, chNum, chTitle, cleanNovelId, activeEngine);
                  chTitle = translated.title;
                  paragraphs = deduplicateChapterParagraphs(translated.paragraphs);
                }

                wtrlabChapterCache.set(cacheKey, { title: chTitle, paragraphs, timestamp: Date.now() });
                multiStats.verifiedCount += 1;
                const wc = paragraphs.join(' ').split(/\s+/).filter(Boolean).length;
                this.pushJobLog(job, 'ok', 'fetch', `Fetched Ch ${chNum} (${chapterOrigin}): "${chTitle}" · ${paragraphs.length}p · ${wc}w`, chNum);
              }

              chapters[slotIndex] = {
                num: chNum,
                title: chTitle,
                paragraphs,
                url: `https://wtr-lab.com/en/novel/${cleanNovelId}/${canonicalSlug}/chapter-${chNum}`,
                sourceEnTitle,
                sourceEnParagraphs,
                origin: chapterOrigin,
                isOmittedFallback: isPlaceholder,
              };

              completedCount++;
              job.currentChapter = Math.max(job.currentChapter || 0, chNum);
              job.chapterTitle = chTitle;
              job.progress = Math.round((completedCount / totalCount) * 85);
              this.persistState(false);

              if (Date.now() - lastEditTime > 3500 && job.chatId && job.botToken && job.telegramMessageId) {
                lastEditTime = Date.now();
                const bar = makeProgressBar(job.progress, 12);
                const tgText =
                  `📖 <b>${escapeXml(job.title)}</b>\n` +
                  `📥 Chapter: <code>${escapeXml(chTitle)}</code>\n\n` +
                  `<code>${bar} ${job.progress}% (${completedCount}/${totalCount})</code>\n` +
                  `⚡ <i>Mode: ${jobServiceMode.toUpperCase()} · ${targetLang.toUpperCase()}</i>`;
                editTelegramMessage(job.botToken, job.chatId, job.telegramMessageId, tgText).catch(() => {});
              }
            }
          })
        );

        if (abortDeadSource && multiStats.verifiedCount === 0) {
          throw new Error(`Novel #${cleanNovelId} (${job.title}) returned 404 / unavailable chapters on WTR-Lab.`);
        }

        if (this.cancelled.has(job.id)) {
          job.status = 'failed';
          job.error = 'Cancelled by user';
          this.finalizeJobStats(job);
          this.persistState(true);
          return;
        }

        const orderedChapters = chapters.filter(Boolean).sort((a, b) => a.num - b.num);
        chapters.length = 0;
        chapters.push(...orderedChapters);

        const isTxt = job.format === 'txt';
        const isHindi = job.language === 'hi';
        const docTitle = isHindi ? `${job.title} [Hindi Edition]` : job.title;
        job.filename = buildSafeNovelFilename(job.title, isHindi ? '_Hindi' : '', job.startChapter, job.totalChapters, isTxt);

        const gate = await this.verifyAndRepairBuiltChapters({
          job,
          builtChapters: chapters,
          platformName: 'WTR-Lab',
          matchedSlug: canonicalSlug,
          jobServiceMode,
          targetLang: isHindi ? 'hi' : 'en',
          isWtrlab: true,
          isFanmtl: false,
        });

        job.status = 'compiling';
        job.progress = 94;
        this.pushJobLog(job, 'info', 'compile', `Packaging ${chapters.length} verified chapter(s) into ${job.format.toUpperCase()}...`);

        const fileBuffer = isTxt
          ? buildTxtFileBuffer(docTitle, job.author, chapters, job.novelUrl, job.language || 'en')
          : await buildEpubZipBuffer(docTitle, job.author, chapters, job.novelUrl, job.language || 'en', job.coverUrl);

        job.chapters = chapters.map((c) => ({ num: c.num, title: c.title, paragraphs: c.paragraphs, url: c.url }));
        job.fileBuffer = fileBuffer;
        job.fileSize = fileBuffer.length;
        multiStats.fileSizeBytes = fileBuffer.length;

        if (!gate.passedAll || fileBuffer.length === 0) {
          const errList = gate.failedDetails.slice(0, 5).map((f) => `Ch ${f.ch}: ${f.reason}`).join('; ');
          const blockReason = errList || `${gate.summary.missing} missing / ${gate.summary.duplicate} duplicate chapter(s)`;
          multiStats.telegramDelivered = false;
          multiStats.telegramBlocked = true;
          multiStats.telegramBlockedReason = blockReason;
          job.error = `Telegram Delivery Blocked (Verification Failed): ${blockReason}`;
          job.status = 'failed';
          job.progress = 100;
          job.completedAt = new Date().toISOString();
          this.pushJobLog(job, 'error', 'deliver', `BLOCKED Telegram delivery ("Exact tab bhejega") — ${blockReason}`);
          this.finalizeJobStats(job);
          this.persistState(true);
          return;
        }

        job.status = 'delivering';
        job.progress = 98;
        if (job.chatId && job.botToken) {
          try {
            const kbLabel = (fileBuffer.length / 1024).toFixed(1);
            await this.sendDocumentToTelegram(
              job.botToken,
              job.chatId,
              fileBuffer,
              job.filename,
              `✅ <b>${escapeXml(job.title)}</b>\n📑 Chapters: <b>${job.startChapter}–${job.totalChapters}</b> (${chapters.length} Verified Exact)\n📦 Size: <code>${kbLabel} KB</code>`
            );
            multiStats.telegramDelivered = true;
          } catch (tgErr: any) {
            multiStats.telegramError = tgErr?.message || 'Telegram upload error';
          }
        }

        job.status = 'completed';
        job.progress = 100;
        job.completedAt = new Date().toISOString();
        this.finalizeJobStats(job);
        this.persistState(true);
      } finally {
        if (isWtrlabScrapeBuild) {
          activeWtrlabScrapeJobs = Math.max(0, activeWtrlabScrapeJobs - 1);
          pumpJinaQueue();
        }
      }
    }
