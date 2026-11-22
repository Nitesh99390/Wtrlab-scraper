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

      // Ensure real canonical slug is resolved so repair/verification never triggers WTR-Lab slug-redirect chapter shifts!
      const canonicalSlug = isWtrlab
        ? await ensureCanonicalWtrlabSlug(String(job.novelId), matchedSlug)
        : matchedSlug;

      const byNum = new Map<number, (typeof builtChapters)[number]>();
      for (const ch of builtChapters) byNum.set(ch.num, ch);

      // Trim any trailing non-existent chapters at the very end if novel chapter_count was overestimated on WTR-Lab
      if (isWtrlab && job.totalChapters > job.startChapter) {
        while (job.totalChapters > job.startChapter) {
          const tailCh = byNum.get(job.totalChapters);
          if (!tailCh || (!tailCh.isOmittedFallback && !this.isPlaceholderChapter(tailCh.paragraphs))) {
            break;
          }
          const probe = await probeWtrlabChapterSsrState(String(job.novelId), canonicalSlug, job.totalChapters, 'high');
          if (probe.confirmedMissing || !probe.exists) {
            byNum.delete(job.totalChapters);
            const idxInArr = builtChapters.findIndex((x) => x.num === job.totalChapters);
            if (idxInArr >= 0) builtChapters.splice(idxInArr, 1);
            if (stats.placeholderCount > 0) stats.placeholderCount -= 1;
            this.pushJobLog(job, 'warn', 'verify', `Trimmed non-existent trailing Ch ${job.totalChapters} (confirmed absent on WTR-Lab).`, job.totalChapters);
            job.totalChapters -= 1;
          } else {
            break;
          }
        }
      }

      const totalRequested = Math.max(1, job.totalChapters - job.startChapter + 1);
      stats.totalRequested = totalRequested;

      this.pushJobLog(
        job,
        'info',
        'verify',
        `Post-Build Zero-Gap Verification Gate: auditing ALL ${totalRequested} chapter slot(s) (${job.startChapter}–${job.totalChapters})...`
      );
      if (job.chatId && job.botToken && job.telegramMessageId) {
        await editTelegramMessage(
          job.botToken,
          job.chatId,
          job.telegramMessageId,
          `🔍 <b>Verifying All ${totalRequested} Chapters (${job.startChapter}–${job.totalChapters})...</b>\n` +
            `📖 <b>${escapeXml(job.title)}</b>\n` +
            `Checking zero-gaps, zero-duplicates, &amp; live ${escapeXml(platformName)} parity.`
        ).catch(() => {});
      }

      // Guarantee every single chapter slot in [startChapter..totalChapters] exists in builtChapters (zero middle gaps!)
      for (let expectedCh = job.startChapter; expectedCh <= job.totalChapters; expectedCh++) {
        if (!byNum.has(expectedCh)) {
          const missingSlot = {
            num: expectedCh,
            title: `Chapter ${expectedCh}`,
            paragraphs: [`[Chapter ${expectedCh} queued for recovery]`],
            url: `https://wtr-lab.com/en/novel/${job.novelId}/${canonicalSlug}/chapter-${expectedCh}`,
            isOmittedFallback: true,
          };
          builtChapters.push(missingSlot);
          byNum.set(expectedCh, missingSlot);
          stats.placeholderCount += 1;
        }
      }
      builtChapters.sort((a, b) => a.num - b.num);

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
        ch: (typeof builtChapters)[number];
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
            const ch = byNum.get(expectedCh)!;

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
              this.isPlaceholderChapter(checkParas) ||
              checkParas.length === 0;
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
        if (!slot) continue;
        const { expectedCh, ch } = slot;

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

      // Pass 2B: Multi-Attempt Deep Repair Pool (4 escalating attempts + SSR author-gap / locked-chapter handling)
      if (flaggedTasks.length > 0 && !this.cancelled.has(job.id)) {
        let cursor = 0;
        const workers = Math.min(HAS_JINA_API_KEY ? 3 : 2, flaggedTasks.length);

        await Promise.all(
          Array.from({ length: workers }, async () => {
            while (cursor < flaggedTasks.length) {
              if (this.cancelled.has(job.id)) return;
              const task = flaggedTasks[cursor++];
              const { expectedCh, ch, reason, isPlaceholder, isDuplicate } = task;
              this.pushJobLog(job, 'retry', 'verify', `Repairing Ch ${expectedCh} (${reason})...`, expectedCh);

              let repairedOk = false;
              let ssrMissingOrLockedReason = '';

              for (let attempt = 1; attempt <= 4 && !repairedOk && !this.cancelled.has(job.id); attempt++) {
                if (attempt > 1) await new Promise((r) => setTimeout(r, 1200 * attempt));
                invalidateSnapshotsForCh(expectedCh);

                // Clear any transient 404 flag on EVERY repair attempt unless SSR confirms missing/locked
                if (isWtrlab) {
                  const base404Key = normalizeJinaBaseUrl(
                    `https://wtr-lab.com/en/novel/${job.novelId}/${canonicalSlug}/chapter-${expectedCh}`
                  );
                  if (attempt >= 2 || isJinaUrlKnown404(base404Key)) {
                    const ssr = await probeWtrlabChapterSsrState(String(job.novelId), canonicalSlug, expectedCh, 'high');
                    if (ssr.confirmedMissing || !ssr.exists) {
                      ssrMissingOrLockedReason = `Chapter ${expectedCh} does not exist on wtr-lab.com (author skipped chapter number)`;
                      break;
                    }
                    if (ssr.locked) {
                      ssrMissingOrLockedReason = `Chapter ${expectedCh} is locked/unreleased on wtr-lab.com`;
                      break;
                    }
                    jinaKnown404Until.delete(base404Key);
                  }
                }

                const modeCycle: WtrlabServiceMode[] = [
                  jobServiceMode,
                  jobServiceMode === 'web' ? 'webplus' : 'web',
                  'webplus',
                  'web',
                ];
                const tryMode = modeCycle[(attempt - 1) % modeCycle.length];

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
                      timeoutMs: 19000 + attempt * 2500,
                    })
                  : null;

                if (!fresh || fresh.paragraphs.length < 1) continue;

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

              // If WTR-Lab itself genuinely skipped a chapter number in the middle (e.g. author jumped Ch 49 -> Ch 51),
              // remove the non-existent ghost slot cleanly instead of failing the entire novel build!
              if (!repairedOk && ssrMissingOrLockedReason && isWtrlab) {
                const idxInArr = builtChapters.findIndex((x) => x.num === expectedCh);
                if (idxInArr >= 0) builtChapters.splice(idxInArr, 1);
                byNum.delete(expectedCh);
                if (stats.placeholderCount > 0) stats.placeholderCount -= 1;
                unavailableCount++;
                this.pushJobLog(job, 'warn', 'verify', `${ssrMissingOrLockedReason} — omitted upstream gap cleanly.`, expectedCh);
                repairedOk = true;
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

      // Pass 3: Final Post-Repair Global Sequence & Zero-Duplicate Audit
      builtChapters.sort((a, b) => a.num - b.num);
      const auditHashes = new Map<string, number>();
      const auditOpenings = new Map<string, number>();
      for (const ch of builtChapters) {
        const chNo = ch.num;
        if (failedDetails.some((f) => f.ch === chNo)) continue;
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

      const summary: JobBuildVerificationSummary = {
        total: builtChapters.length,
        exact: exactCount,
        near: nearCount,
        repaired: repairedCount,
        mismatch: mismatchCount,
        missing: missingCount,
        duplicate: duplicateCount,
        unavailable: unavailableCount,
      };
      stats.verificationSummary = summary;

      const passedAll =
        !this.cancelled.has(job.id) &&
        builtChapters.length > 0 &&
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
        const hasUnverifiedTotal = Boolean(matched?.hasUnverifiedCount) || !matched?.chaptersCount;

        if (hasGenericTitle || hasUnverifiedTotal || rangeMode === 'all' || !explicitEndCh || isStaleMeta || !matched?.slug || matched.slug === 'novel') {
          const liveMeta = await fetchWtrlabLiveMetadata(cleanNovelId, urlSlug || matched?.slug, rangeMode === 'all' || isStaleMeta || hasUnverifiedTotal).catch(() => null);
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

        let verifiedTotal = Math.max(
          Number(matched?.hasUnverifiedCount ? 0 : matched?.chaptersCount) || 0,
          Number(wtrlabKnownTotalChapters.get(cleanNovelId) || 0)
        );
        if (verifiedTotal <= 0 && (rangeMode === 'all' || !explicitEndCh)) {
          const ssrProbe1 = await probeWtrlabChapterSsrState(cleanNovelId, canonicalSlug, 1, 'high').catch(() => null);
          if (ssrProbe1?.totalChapters && ssrProbe1.totalChapters > 0) {
            verifiedTotal = ssrProbe1.totalChapters;
          }
        }
        const detectedTotal = verifiedTotal || Number(matched?.chaptersCount || 0) || 100;
        job.startChapter = Math.max(1, Number(job.startChapter) || 1);
        job.totalChapters =
          rangeMode === 'all'
            ? detectedTotal
            : explicitEndCh && explicitEndCh > 0
            ? (verifiedTotal > 0 ? Math.min(explicitEndCh, verifiedTotal) : explicitEndCh)
            : detectedTotal;
        job.totalChapters = Math.max(job.startChapter, job.totalChapters);

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
        let consecutiveConfirmed404 = 0;
        let abortDeadSource = false;
        const chConcurrency = Math.min(HAS_JINA_API_KEY ? 4 : 2, totalCount);
        const jobServiceMode = normalizeServiceMode(job.serviceMode);
        const targetLang = job.language === 'hi' ? 'hi' : 'en';

        await Promise.all(
          Array.from({ length: chConcurrency }, async () => {
            while (nextChapterNum <= job.totalChapters) {
              if (this.cancelled.has(job.id) || abortDeadSource) return;
              const chNum = nextChapterNum++;
              const slotIndex = chNum - job.startChapter;

              const cacheKey = `${cleanNovelId}:${chNum}:${targetLang}:${jobServiceMode}:${targetLang === 'hi' ? 'auto' : 'en'}`;
              const enCacheKey = `${cleanNovelId}:${chNum}:en:${jobServiceMode}:en`;
              const cached = wtrlabChapterCache.get(cacheKey);
              let chTitle = targetLang === 'hi' ? `अध्याय ${chNum}` : `Chapter ${chNum}`;
              let paragraphs: string[] = [];
              let sourceEnTitle: string | undefined;
              let sourceEnParagraphs: string[] | undefined;
              let chapterOrigin = '';

              if (cached && cached.paragraphs.length >= 1 && Date.now() - cached.timestamp < 24 * 60 * 60 * 1000) {
                chTitle = cached.title;
                paragraphs = deduplicateChapterParagraphs(cached.paragraphs);
                chapterOrigin = 'cache';
                if (targetLang === 'en') {
                  sourceEnTitle = chTitle;
                  sourceEnParagraphs = [...paragraphs];
                } else {
                  const enCached = wtrlabChapterCache.get(enCacheKey);
                  if (enCached && enCached.paragraphs.length >= 1) {
                    sourceEnTitle = enCached.title;
                    sourceEnParagraphs = deduplicateChapterParagraphs(enCached.paragraphs);
                  }
                }
              }

              // Inline resilient retry loop (up to 2 immediate passes during download so transient network/CSR hiccups recover right away!)
              for (let dlAttempt = 1; dlAttempt <= 2 && paragraphs.length === 0 && !this.cancelled.has(job.id); dlAttempt++) {
                if (dlAttempt === 2) {
                  const chapterUrlKey = `https://wtr-lab.com/en/novel/${cleanNovelId}/${canonicalSlug}/chapter-${chNum}`;
                  if (isJinaUrlKnown404(chapterUrlKey)) break;
                  multiStats.retryCount += 1;
                  await new Promise((r) => setTimeout(r, 850));
                }

                let scraped = await scrapeWtrlabChapterClean({
                  novelId: cleanNovelId,
                  slug: canonicalSlug,
                  chapterNo: chNum,
                  serviceMode: dlAttempt === 2 ? (jobServiceMode === 'web' ? 'webplus' : jobServiceMode) : jobServiceMode,
                  language: 'en',
                  novelTitle: job.title,
                  skipCache: dlAttempt > 1,
                  priority: 'high',
                  timeoutMs: dlAttempt === 2 ? 21000 : 18000,
                });

                // Immediate in-flight duplicate guard: if content collides with an already-downloaded chapter, bypass cache & re-fetch!
                if (scraped && scraped.paragraphs.length >= 1) {
                  const fp = computeChapterFingerprint(scraped.paragraphs);
                  const dupCh = fp.fullHash ? seenLiveFingerprints.get(fp.fullHash) : undefined;
                  if (dupCh && dupCh !== chNum) {
                    multiStats.retryCount += 1;
                    scraped = await scrapeWtrlabChapterClean({
                      novelId: cleanNovelId,
                      slug: canonicalSlug,
                      chapterNo: chNum,
                      serviceMode: jobServiceMode === 'web' ? 'webplus' : 'web',
                      language: 'en',
                      novelTitle: job.title,
                      skipCache: true,
                      priority: 'high',
                      timeoutMs: 21000,
                    });
                  }
                }

                if (scraped && scraped.paragraphs.length >= 1) {
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
                  wtrlabChapterCache.set(enCacheKey, {
                    title: processed.title,
                    paragraphs: processed.paragraphs,
                    timestamp: Date.now(),
                  });

                  const fp = computeChapterFingerprint(paragraphs);
                  if (fp.fullHash && !seenLiveFingerprints.has(fp.fullHash)) {
                    seenLiveFingerprints.set(fp.fullHash, chNum);
                  }
                }
              }

              const isPlaceholder = paragraphs.length === 0;
              if (isPlaceholder) {
                chTitle = `Chapter ${chNum}`;
                paragraphs = [
                  `[Chapter ${chNum} of "${job.title}" queued for deep verification recovery.]`,
                ];
                multiStats.placeholderCount += 1;
                this.pushJobLog(job, 'warn', 'fetch', `Initial fetch missed Ch ${chNum} — queued for 4-attempt verification repair.`, chNum);

                const isConfirmed404 = isJinaUrlKnown404(`https://wtr-lab.com/en/novel/${cleanNovelId}/${canonicalSlug}/chapter-${chNum}`);
                if (isConfirmed404) {
                  consecutiveConfirmed404 += 1;
                  if (multiStats.verifiedCount === 0 && consecutiveConfirmed404 >= 5) {
                    abortDeadSource = true;
                    this.pushJobLog(job, 'error', 'fetch', `Aborting: novel #${cleanNovelId} chapters confirmed 404 on WTR-Lab.`, chNum);
                  }
                } else {
                  consecutiveConfirmed404 = 0;
                }
              } else {
                consecutiveConfirmed404 = 0;
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

        const runGate = () =>
          this.verifyAndRepairBuiltChapters({
            job,
            builtChapters: chapters,
            platformName: 'WTR-Lab',
            matchedSlug: canonicalSlug,
            jobServiceMode,
            targetLang: isHindi ? 'hi' : 'en',
            isWtrlab: true,
            isFanmtl: false,
          });
        let gate = await runGate();

        // A single transient Jina / network hiccup must never sink a whole 500+ chapter build:
        // re-run the (idempotent) repair gate up to 2 more times, only for the chapters that are still failing.
        for (let extraPass = 1; extraPass <= 2 && !gate.passedAll && gate.failedDetails.length > 0 && !this.cancelled.has(job.id); extraPass++) {
          this.pushJobLog(
            job,
            'retry',
            'verify',
            `Gate still failing for ${gate.failedDetails.length} chapter(s) [${gate.failedDetails.slice(0, 8).map((f) => f.ch).join(', ')}] — extra repair pass ${extraPass}/2 after cool-down...`
          );
          await new Promise((r) => setTimeout(r, 4500 * extraPass));
          for (const f of gate.failedDetails) {
            jinaKnown404Until.delete(normalizeJinaBaseUrl(`https://wtr-lab.com/en/novel/${cleanNovelId}/${canonicalSlug}/chapter-${f.ch}`));
          }
          gate = await runGate();
        }

        const finalEndChapter = chapters.length > 0 ? chapters[chapters.length - 1].num : job.totalChapters;
        job.filename = buildSafeNovelFilename(job.title, isHindi ? '_Hindi' : '', job.startChapter, finalEndChapter, isTxt);

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
              `✅ <b>${escapeXml(job.title)}</b>\n📑 Chapters: <b>${job.startChapter}–${finalEndChapter}</b> (${chapters.length} Verified Exact · 0 Missing · 0 Duplicates)\n📦 Size: <code>${kbLabel} KB</code>`
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
