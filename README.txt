NovelCraft Studio - WTR-Lab Zero-Drop & Zero-Duplicate Scraper Section
======================================================================

Files Included:
1. frontend/WtrlabBrowser.tsx
   Clean, deduplicated WTR-Lab React UI (reusable <NovelCard /> across rails & directory, live parity/duplicate check, scrape modal).

2. backend/wtrlab_live_extractor.ts
   - Canonical WTR-Lab Slug Resolver (`ensureCanonicalWtrlabSlug`) — prevents Next.js `/novel/` -> `/<real-slug>/` +1 chapter-shift duplicates.
   - Authoritative SSR `__NEXT_DATA__` Chapter Probe (`probeWtrlabChapterSsrState`) — detects true 404 / author-skipped / locked chapters in ~400ms while ensuring slow-hydrating valid chapters NEVER falsely trip the 404 circuit breaker (including Jina 422 selector timeouts).
   - Deep Rescue Pass (`no-wait` selector + 23s timeout) — recovers slow or non-`<p>` markup chapters so zero chapters in the middle of a novel are ever dropped.
   - Dialogue-Safe Structural Boundary Guard — never truncates chapters when story dialogue/prose mentions `"Chapter N+1..."`, while cleanly stopping preloaded `#N+1` / `#N+2` infinite-scroll slots.
   - Roman Numeral (`Chapter XIV`), Word Number (`Chapter Twenty-Three`), Prologue/Epilogue, Heading-less Short Chapter, and Single-Wall-of-Text auto-splitter support.
   - Intra-chapter paragraph deduplicator (`deduplicateChapterParagraphs`) & SHA-1 multi-anchor chapter fingerprinting (`computeChapterFingerprint`).

3. backend/wtrlab_catalog_and_routes.ts
   - Live `/en` homepage multi-rail `__NEXT_DATA__` harvester + `/en/novel-finder` & `/en/novel-list` sync.
   - Hardened Jina HTTP 422 vs 404 handling (never poisons valid slow chapters as 404).
   - Express routes for `/api/wtrlab/rails`, `/api/wtrlab/feed`, `/api/wtrlab/novel/:id`, `/api/wtrlab/chapter`, `/api/wtrlab/verify-chapter`, `/api/wtrlab/verify-all/*`, and `/api/wtrlab/cover`.

4. backend/wtrlab_build_gate.ts
   - Inline 2-pass download retry + 4-attempt escalating Post-Build Verification & Repair Gate (`verifyAndRepairBuiltChapters`).
   - Guarantees every chapter slot `[startChapter..totalChapters]` is filled, verified, and ordered with zero middle gaps and zero duplicates, while cleanly handling genuine upstream author-skipped numbers or trailing overestimates.

5. backend/wtrlab_telegram_handlers.ts
   - Clean Telegram `/wtr` & `/wtrlab` commands, interactive inline mode/language cards, and resilient error handling.
