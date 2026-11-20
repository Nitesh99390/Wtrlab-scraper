import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';

// Host environment shims matching NovelCraft Studio server runtime
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const RUNTIME_DIR = '/tmp/wtrlab_test_runtime';
fs.mkdirSync(RUNTIME_DIR, { recursive: true });

function migrateLegacyFileToRuntime(_a: string, _b: string) {}
function atomicWriteJsonFile(file: string, data: any) {
  fs.writeFileSync(file, JSON.stringify(data));
}
function escapeXml(s: string) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function unescapeHtml(s: string) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

const wtrlabDynamicNovels = new Map<string, any>();
const app = {
  get: (_route: string, _fn: any) => {},
  post: (_route: string, _fn: any) => {},
};
type Request = any;
type Response = any;

// Build combined test runner dynamically so we execute the exact refactored backend code!
async function main() {
  const extractorCode = fs.readFileSync(path.join(process.cwd(), 'backend/wtrlab_live_extractor.ts'), 'utf-8');
  const catalogCode = fs.readFileSync(path.join(process.cwd(), 'backend/wtrlab_catalog_and_routes.ts'), 'utf-8');

  // Strip TS type annotations via tsx transpile via dynamic import of generated module
  const combinedTs = `
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';

const USER_AGENT = ${JSON.stringify(USER_AGENT)};
const RUNTIME_DIR = ${JSON.stringify(RUNTIME_DIR)};
const __dirname = RUNTIME_DIR;
function migrateLegacyFileToRuntime(_a: string, _b: string) {}
function atomicWriteJsonFile(file: string, data: any, _p?: boolean) { fs.writeFileSync(file, JSON.stringify(data)); }
function escapeXml(s: string) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function unescapeHtml(s: string) { return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }
export const wtrlabDynamicNovels = new Map<string, any>();
const app = { get: (_r: string, _f: any) => {}, post: (_r: string, _f: any) => {} };
type Request = any;
type Response = any;

${extractorCode}

${catalogCode}

export {
  ensureCanonicalWtrlabSlug,
  scrapeWtrlabChapterClean,
  computeChapterFingerprint,
  deduplicateChapterParagraphs,
  verifySingleWtrlabChapter,
  harvestWtrlabPageUrl,
  fetchWtrlabLiveMetadata,
};
`;

  const tmpModPath = path.join(process.cwd(), 'test/_combined_runner.ts');
  fs.writeFileSync(tmpModPath, combinedTs, 'utf-8');

  const mod = await import('./_combined_runner.ts');

  console.log('=== TEST 1: Canonical Slug Resolution on Novel #7226 (given placeholder slug "novel") ===');
  const slug7226 = await mod.ensureCanonicalWtrlabSlug('7226', 'novel');
  console.log('Resolved Canonical Slug for 7226:', slug7226);
  if (slug7226 !== 'nine-dragon-god-emperor') {
    throw new Error(`Expected canonical slug 'nine-dragon-god-emperor', got '${slug7226}'`);
  }

  console.log('\n=== TEST 2: Scrape Ch 1, Ch 2, Ch 3 of #7226 (when caller only passed generic slug "novel"!) ===');
  const fingerprints = new Map<string, number>();
  for (const chNo of [1, 2, 3]) {
    const ch = await mod.scrapeWtrlabChapterClean({
      novelId: '7226',
      slug: 'novel', // Previously caused +1 shift & duplicate!
      chapterNo: chNo,
      serviceMode: 'ai',
      skipCache: true,
    });
    if (!ch) throw new Error(`Failed to scrape 7226 Ch ${chNo}`);
    const fp = mod.computeChapterFingerprint(ch.paragraphs);
    console.log(`  Ch ${chNo}: title="${ch.title}" | paras=${ch.paragraphs.length} | hash=${fp.fullHash} | first="${ch.paragraphs[0].slice(0, 65)}..."`);
    if (fingerprints.has(fp.fullHash)) {
      throw new Error(`DUPLICATE DETECTED! Ch ${chNo} has same hash as Ch ${fingerprints.get(fp.fullHash)}`);
    }
    fingerprints.set(fp.fullHash, chNo);
  }

  console.log('\n=== TEST 3: Guest AI Gate (>Ch 10) Seamless Fallback on Novel #116588 Ch 11 & Ch 12 ===');
  for (const chNo of [11, 12]) {
    const ch = await mod.scrapeWtrlabChapterClean({
      novelId: '116588',
      chapterNo: chNo,
      serviceMode: 'ai', // Requested AI on >Ch 10 -> should seamlessly fall back and extract full chapter!
      skipCache: true,
    });
    if (!ch) throw new Error(`Failed to scrape 116588 Ch ${chNo}`);
    const fp = mod.computeChapterFingerprint(ch.paragraphs);
    console.log(`  Ch ${chNo}: title="${ch.title}" | paras=${ch.paragraphs.length} | hash=${fp.fullHash} | first="${ch.paragraphs[0].slice(0, 65)}..."`);
    if (fingerprints.has(fp.fullHash)) {
      throw new Error(`DUPLICATE DETECTED on 116588 Ch ${chNo}!`);
    }
    fingerprints.set(fp.fullHash, chNo);
  }

  console.log('\n=== TEST 4: Non-numbered Raw Author Title Normalization & Web-mode Empty Shell Fallback (#29111 Ch 1 & Ch 15) ===');
  for (const [chNo, mode] of [[1, 'ai'], [15, 'web']] as const) {
    const ch = await mod.scrapeWtrlabChapterClean({
      novelId: '29111',
      chapterNo: chNo,
      serviceMode: mode, // Ch 15 ?service=web is empty on 29111 -> must auto-fallback to webplus!
      skipCache: true,
    });
    if (!ch) throw new Error(`Failed to scrape 29111 Ch ${chNo} (${mode})`);
    const fp = mod.computeChapterFingerprint(ch.paragraphs);
    console.log(`  Ch ${chNo} (${mode}): title="${ch.title}" | paras=${ch.paragraphs.length} | hash=${fp.fullHash}`);
    if (fingerprints.has(fp.fullHash)) {
      throw new Error(`DUPLICATE DETECTED on 29111 Ch ${chNo}!`);
    }
    fingerprints.set(fp.fullHash, chNo);
  }

  console.log('\n=== TEST 5: Out-of-Range / 404 Chapter Fast Circuit Breaker (#29111 Ch 99999) ===');
  const t0 = Date.now();
  const missing = await mod.scrapeWtrlabChapterClean({
    novelId: '29111',
    chapterNo: 99999,
    serviceMode: 'webplus',
    skipCache: true,
  });
  const t1 = Date.now();
  const missingCached = await mod.scrapeWtrlabChapterClean({
    novelId: '29111',
    chapterNo: 99999,
    serviceMode: 'webplus',
    skipCache: true,
  });
  const t2 = Date.now();
  console.log(`  Out-of-range #1 returned=${missing} in ${t1 - t0}ms | #2 (circuit-breaker) returned=${missingCached} in ${t2 - t1}ms`);
  if (missing !== null || missingCached !== null || (t2 - t1) > 50) {
    throw new Error('404/422 circuit breaker did not short-circuit immediately!');
  }

  console.log('\n=== TEST 6: Live Homepage Multi-Rail Harvester (/en) ===');
  const harvested = await mod.harvestWtrlabPageUrl('https://wtr-lab.com/en', 'Homepage Live', 12000, true);
  console.log(`  Harvested ${harvested.length} real novels from https://wtr-lab.com/en (unique pool size: ${mod.wtrlabDynamicNovels.size})`);
  if (mod.wtrlabDynamicNovels.size < 15) {
    throw new Error('Expected at least 15 novels from homepage harvest');
  }

  // Cleanup temp runner & timers
  fs.unlinkSync(tmpModPath);
  console.log('\n✅ ALL 6 LIVE WTR-LAB INTEGRATION TESTS PASSED WITH ZERO DUPLICATES!');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
});
