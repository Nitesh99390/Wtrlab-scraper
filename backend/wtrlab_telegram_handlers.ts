    private buildWtrlabInlineKeyboard(regToken: string, total: number) {
      const langTag = this.defaultLanguage === 'hi' ? ' [🇮🇳 HI]' : ' [🇬🇧 EN]';
      const switchLangText = this.defaultLanguage === 'hi' ? '🇬🇧 Switch to EN' : '🇮🇳 Switch to HI';
      const m = this.defaultServiceMode;
      const demoEnd = Math.min(25, Math.max(1, total));
      return {
        inline_keyboard: [
          [
            { text: `⚡ 1. Demo (1-${demoEnd})${langTag}`, callback_data: `scrape:demo:${regToken}:${demoEnd}` },
            { text: `📚 3. All (1-${total.toLocaleString()})${langTag}`, callback_data: `scrape:all:${regToken}:${total}` },
          ],
          [
            { text: `⚙️ 2. Custom Range`, callback_data: `scrape:custom:${regToken}:${total}` },
            { text: switchLangText, callback_data: `togglelang:${regToken}` },
          ],
          [
            { text: m === 'web' ? '✓ Web' : 'Web', callback_data: `setmode:web:${regToken}` },
            { text: m === 'webplus' ? '✓ Web+' : 'Web+', callback_data: `setmode:webplus:${regToken}` },
            { text: m === 'ai' ? '✓ AI' : 'AI', callback_data: `setmode:ai:${regToken}` },
          ],
        ],
      };
    }

    private async resolveWtrlabInfo(novelId: string, slugHint?: string) {
      const cleanId = String(novelId).replace(/^wtr_/i, '').trim();
      let matched: any =
        wtrlabDynamicNovels.get(cleanId) ||
        wtrlabLiveMetaCache.get(cleanId)?.data ||
        null;

      const hasGenericTitle =
        !matched ||
        !matched.title ||
        /^WTR-Lab Novel #?\d+$/i.test(matched.title) ||
        matched.title.includes('(WTR-Lab #');
      const isStaleMeta = !matched?.updatedAtMs || (Date.now() - Number(matched.updatedAtMs) > 15 * 60 * 1000);
      const lacksRealSlug = !matched?.slug || matched.slug === 'novel' || /^novel-\d+$/i.test(matched.slug);
      const lacksVerifiedCountOrAuthor =
        !matched?.chaptersCount ||
        Boolean(matched?.hasUnverifiedCount) ||
        !matched?.author ||
        matched.author === 'WTR-Lab Author';

      if (hasGenericTitle || isStaleMeta || lacksRealSlug || lacksVerifiedCountOrAuthor) {
        const liveMeta = await Promise.race([
          fetchWtrlabLiveMetadata(cleanId, slugHint || matched?.slug, isStaleMeta || lacksVerifiedCountOrAuthor).catch(() => null),
          new Promise<null>((r) => setTimeout(() => r(null), 22000)),
        ]);
        if (liveMeta) {
          matched = { ...(matched || {}), ...liveMeta };
        }
      }

      const canonicalSlug = await ensureCanonicalWtrlabSlug(cleanId, slugHint || matched?.slug);
      const humanTitle =
        matched?.title ||
        (canonicalSlug && canonicalSlug !== 'novel'
          ? canonicalSlug.replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())
          : `WTR-Lab Novel #${cleanId}`);
      const novelUrl = `https://wtr-lab.com/en/novel/${cleanId}/${canonicalSlug}`;
      const safeCover = wtrlabLiveCoverMap.get(cleanId) || normalizeWtrlabCoverUrl(matched?.coverUrl);

      let knownChapters = Math.max(
        Number(matched?.hasUnverifiedCount ? 0 : matched?.chaptersCount) || 0,
        Number(wtrlabKnownTotalChapters.get(cleanId) || 0)
      );
      if (knownChapters <= 0) {
        const quickProbe = await probeWtrlabChapterSsrState(cleanId, canonicalSlug, 1, 'high').catch(() => null);
        if (quickProbe?.totalChapters && quickProbe.totalChapters > 0) {
          knownChapters = quickProbe.totalChapters;
        }
      }

      return {
        novelId: cleanId,
        slug: canonicalSlug,
        title: humanTitle,
        author: matched?.author || 'WTR-Lab Author',
        totalChapters: Math.max(1, knownChapters || Number(matched?.chaptersCount) || 100),
        hasUnverifiedCount: knownChapters <= 0,
        status: matched?.status || 'Ongoing',
        coverUrl: safeCover,
        novelUrl,
      };
    }

    private async sendWtrlabNovelCard(chatId: string, novelId: string, slugHint?: string) {
      try {
        const info = await this.resolveWtrlabInfo(novelId, slugHint);
        const regToken = registerNovelForCallback({
          novelUrl: info.novelUrl,
          novelId: `wtr_${info.novelId}`,
          title: info.title,
          totalChapters: info.totalChapters,
          hasUnverifiedCount: info.hasUnverifiedCount,
          platform: 'wtrlab',
          coverUrl: info.coverUrl || undefined,
        });

        const inlineKeyboard = this.buildWtrlabInlineKeyboard(regToken, info.totalChapters);
        const modeLabel = this.getServiceModeLabel(this.defaultServiceMode);
        const langLabel = this.defaultLanguage === 'hi' ? '🇮🇳 Hindi' : '🇬🇧 English';

        const promptMsg =
          `📖 <b>${escapeXml(info.title)} (WTR-Lab #${info.novelId})</b>\n` +
          `✍️ Author: <code>${escapeXml(info.author)}</code>\n` +
          `📑 Chapters: <b>${info.totalChapters.toLocaleString()} Chapters</b> · ${escapeXml(info.status)}\n` +
          `🌐 Website: <code>${info.novelUrl}</code>\n` +
          `🧪 WTR Engine: <b>${modeLabel}</b>\n` +
          `🌐 Language: <b>${langLabel}</b> · Format: <b>${this.defaultFormat.toUpperCase()}</b>\n\n` +
          `👇 <b>Download ya Mode (Web / Web+ / AI) change karne ke liye button chunein:</b>\n` +
          `1️⃣ <b>Demo:</b> Chapters 1–${Math.min(25, info.totalChapters)}\n` +
          `2️⃣ <b>Custom:</b> Apni chapter range\n` +
          `3️⃣ <b>All Chapters:</b> Full novel (1–${info.totalChapters.toLocaleString()})\n\n` +
          `⚡ <i>Canonical-slug zero-duplicate WTR-Lab chapter scraper active!</i>`;

        if (info.coverUrl) {
          const tgCoverUrl = info.coverUrl.includes('wtr-lab.com')
            ? `https://wsrv.nl/?url=${encodeURIComponent(info.coverUrl)}&output=jpg`
            : info.coverUrl;
          await this.sendPhoto(chatId, tgCoverUrl, promptMsg, inlineKeyboard).catch(() =>
            this.sendMessage(chatId, promptMsg, inlineKeyboard)
          );
        } else {
          await this.sendMessage(chatId, promptMsg, inlineKeyboard);
        }
      } catch (err: any) {
        await this.sendMessage(
          chatId,
          `⚠️ WTR-Lab novel #${escapeXml(String(novelId))} load karne mein error aaya: <code>${escapeXml(err?.message || 'Timeout')}</code>\nKripya kuch seconds baad dobara try karein.`
        );
      }
    }


// --- Telegram /wtr Commands ---

      if (['/wtr', 'wtr', '/wtrlab', 'wtrlab'].includes(commandWord) || text === '🌐 WTR-Lab Novels') {
        const rawQuery = text.startsWith('/') || /^wtr(?:lab)?\b/i.test(lowerText)
          ? text.replace(/^\/?(?:wtrlab|wtr)\s*/i, '').trim()
          : '';

        if (rawQuery) {
          const directRef = extractWtrlabNovelRef(rawQuery);
          if (directRef) {
            await this.sendWtrlabNovelCard(chatId, directRef.novelId, directRef.slug);
            return;
          }
          if (/^\d{1,7}$/.test(rawQuery)) {
            await this.sendWtrlabNovelCard(chatId, rawQuery);
            return;
          }

          const qLower = rawQuery.toLowerCase();
          const filterPool = (list: any[]) =>
            list.filter(
              (n) =>
                (n.title && n.title.toLowerCase().includes(qLower)) ||
                (n.author && n.author.toLowerCase().includes(qLower)) ||
                String(n.id) === rawQuery
            );

          let matches = filterPool(getDeduplicatedWtrlabPool());
          if (matches.length < 3) {
            await harvestWtrlabPageUrl(
              `https://wtr-lab.com/en/novel-finder?text=${encodeURIComponent(rawQuery)}`,
              'Search Match',
              7000
            ).catch(() => []);
            matches = filterPool(getDeduplicatedWtrlabPool());
          }

          const top = matches.slice(0, 5);
          if (top.length === 0) {
            await this.sendMessage(
              chatId,
              `🔍 WTR-Lab par "<b>${escapeXml(rawQuery)}</b>" ke liye koi novel nahi mila.\n\n👉 Direct WTR-Lab URL ya Novel ID bhejein (jaise <code>/wtr 7226</code> ya <code>https://wtr-lab.com/en/novel/7226/...</code>)`,
              MAIN_MENU_KEYBOARD
            );
            return;
          }

          let listMsg = `🌐 <b>WTR-Lab Search Results for "${escapeXml(rawQuery)}":</b>\n🧪 Mode: <b>${this.defaultServiceMode.toUpperCase()}</b> · Lang: <b>${this.defaultLanguage.toUpperCase()}</b>\n\n`;
          const rows: any[] = [];
          for (let idx = 0; idx < top.length; idx++) {
            const n = top[idx];
            const nid = String(n.rawId || n.id);
            const chCnt = Math.max(1, Number(n.chaptersCount) || 100);
            const slug = n.slug && n.slug !== 'novel' ? n.slug : 'novel';
            const tok = registerNovelForCallback({
              novelUrl: `https://wtr-lab.com/en/novel/${nid}/${slug}`,
              novelId: `wtr_${nid}`,
              title: n.title,
              totalChapters: chCnt,
              platform: 'wtrlab',
              coverUrl: n.coverUrl,
            });
            listMsg += `${idx + 1}. <b>${escapeXml(n.title)}</b> (<code>#${nid}</code> · ${chCnt} Chs)\n`;
            const shortName = n.title.slice(0, 18) + (n.title.length > 18 ? '…' : '');
            rows.push([
              { text: `⚡ ${shortName} (1-${Math.min(25, chCnt)})`, callback_data: `scrape:demo:${tok}:${Math.min(25, chCnt)}` },
              { text: `📚 All (${chCnt})`, callback_data: `scrape:all:${tok}:${chCnt}` },
              { text: `📋 Card`, callback_data: `wtrcard:${nid}` },
            ]);
          }
          listMsg += `\n👇 <i>Neeche 1-click button se turant download karein:</i>`;
          await this.sendMessage(chatId, listMsg, { inline_keyboard: rows });
          return;
        }

        // Ensure trending feed is enriched from live homepage if cold
        await ensureWtrlabLiveFeedEnriched().catch(() => {});
        const pool = getDeduplicatedWtrlabPool().slice(0, 5);
        let wtrMsg =
          `🌐 <b>WTR-Lab Live Novels (wtr-lab.com/en):</b>\n` +
          `🧪 Active Engine: <b>${this.getServiceModeLabel(this.defaultServiceMode)}</b> · Lang: <b>${this.defaultLanguage.toUpperCase()}</b>\n\n`;
        const rows: any[] = [];
        pool.forEach((n, idx) => {
          const nid = String(n.rawId || n.id);
          const chCnt = Math.max(1, Number(n.chaptersCount) || 100);
          const slug = n.slug && n.slug !== 'novel' ? n.slug : 'novel';
          const url = `https://wtr-lab.com/en/novel/${nid}/${slug}`;
          const tok = registerNovelForCallback({
            novelUrl: url,
            novelId: `wtr_${nid}`,
            title: n.title,
            totalChapters: chCnt,
            platform: 'wtrlab',
            coverUrl: n.coverUrl,
          });
          wtrMsg += `${idx + 1}. <b>${escapeXml(n.title)}</b>\n• #${nid} · <b>${chCnt} Chapters</b>\n🔗 <code>${url}</code>\n\n`;
          const shortName = n.title.slice(0, 18) + (n.title.length > 18 ? '…' : '');
          rows.push([
            { text: `⚡ ${shortName} (1-${Math.min(25, chCnt)})`, callback_data: `scrape:demo:${tok}:${Math.min(25, chCnt)}` },
            { text: `📚 All (${chCnt})`, callback_data: `scrape:all:${tok}:${chCnt}` },
            { text: `📋 Card`, callback_data: `wtrcard:${nid}` },
          ]);
        });
        wtrMsg += `💡 <i>Search:</i> <code>/wtr &lt;novel name or ID&gt;</code> · <i>Ya koi bhi WTR-Lab link chat me bhejein!</i>`;
        await this.sendMessage(chatId, wtrMsg, { inline_keyboard: rows });
        return;
      }
