NovelCraft Studio - WTR-Lab Clean & Advanced Scraper Section
============================================================

Total Refactored Codebase: ~5,756 lines (reduced from ~8,377 lines — over 2,600 lines of dead/fake/duplicate bloat removed!)

Files Included:
1. frontend/WtrlabBrowser.tsx
   Clean, deduplicated WTR-Lab React UI (reusable <NovelCard /> across rails & directory, live parity/duplicate check, scrape modal).

2. backend/wtrlab_live_extractor.ts
   - Canonical WTR-Lab Slug Resolver (`ensureCanonicalWtrlabSlug`) — fixes the Next.js `/novel/` -> `/<real-slug>/` +1 chapter-shift duplicate bug!
   - Scoped `div.chapter-wrap:first-of-type` + `.chapter-body p` DOM extraction with ad/iframe/tracker stripping (`X-Remove-Selector`) — eliminates preloaded `#N+1` / `#N+2` chapter bleed.
   - Automatic Guest AI Gate (>Ch 10) & empty `?service=web` fallback cascade (`AI -> Web+ -> Web`) with learned per-novel mode cache.
   - Intra-chapter paragraph deduplicator (`deduplicateChapterParagraphs`) & SHA-1 multi-anchor chapter fingerprinting (`computeChapterFingerprint`).
   - Single-flight request coalescing (`wtrlabChapterInflight`) + HTTP 404/422 fast circuit-breaker + AES-256-GCM `/api/reader/get` fast path.

3. backend/wtrlab_catalog_and_routes.ts
   - Live `/en` homepage multi-rail `__NEXT_DATA__` harvester + `/en/novel-finder` & `/en/novel-list` sync.
   - Removed all synthetic fake novel generators, Unsplash placeholder arrays, and unrelated Webnovel/FanMTL bloat.
   - Express routes for `/api/wtrlab/rails`, `/api/wtrlab/feed`, `/api/wtrlab/novel/:id`, `/api/wtrlab/chapter`, `/api/wtrlab/verify-chapter`, `/api/wtrlab/verify-all/*`, and `/api/wtrlab/cover`.

4. backend/wtrlab_build_gate.ts
   - Unified `executeJob` + 3-Pass Post-Build Verification & Repair Gate (`verifyAndRepairBuiltChapters`) using SHA-1 chapter fingerprints and canonical slugs so zero duplicate or missing chapters ever ship to Telegram.

5. backend/wtrlab_telegram_handlers.ts
   - Clean Telegram `/wtr` & `/wtrlab` commands, interactive inline mode/language cards, and resilient error handling.
