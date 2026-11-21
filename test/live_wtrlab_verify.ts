import fs from 'fs';
import path from 'path';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const RUNTIME_DIR = '/tmp/wtrlab_test_runtime_v2';
fs.mkdirSync(RUNTIME_DIR, { recursive: true });

async function main() {
  const extractorCode = fs.readFileSync(path.join(process.cwd(), 'backend/wtrlab_live_extractor.ts'), 'utf-8');
  const catalogCode = fs.readFileSync(path.join(process.cwd(), 'backend/wtrlab_catalog_and_routes.ts'), 'utf-8');
  const buildGateCode = fs.readFileSync(path.join(process.cwd(), 'backend/wtrlab_build_gate.ts'), 'utf-8');
  const telegramCode = fs.readFileSync(path.join(process.cwd(), 'backend/wtrlab_telegram_handlers.ts'), 'utf-8');

  // Synthesize full host TypeScript class wrapper around ALL 4 backend files so TypeScript/tsx validates every single line, type, method, and variable!
  const fullHostTs = `
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';

const USER_AGENT = ${JSON.stringify(USER_AGENT)};
const RUNTIME_DIR = ${JSON.stringify(RUNTIME_DIR)};
const __dirname = RUNTIME_DIR;
const MAIN_MENU_KEYBOARD = { keyboard: [] };

type ScrapeJob = {
  id: string;
  novelId: string;
  novelUrl: string;
  title: string;
  author: string;
  synopsis?: string;
  coverUrl?: string;
  startChapter: number;
  totalChapters: number;
  currentChapter?: number;
  chapterTitle?: string;
  progress: number;
  status: string;
  format: 'epub' | 'txt';
  language?: 'en' | 'hi';
  serviceMode?: string;
  filename?: string;
  fileBuffer?: Buffer;
  fileSize?: number;
  chapters?: any[];
  error?: string;
  completedAt?: string;
  chatId?: string;
  botToken?: string;
  telegramMessageId?: number;
  buildStats?: any;
};

type JobBuildVerificationSummary = {
  total: number;
  exact: number;
  near: number;
  repaired: number;
  mismatch: number;
  missing: number;
  duplicate: number;
  unavailable: number;
};

function migrateLegacyFileToRuntime(_a: string, _b: string) {}
function atomicWriteJsonFile(file: string, data: any, _p?: boolean) { fs.writeFileSync(file, JSON.stringify(data)); }
function escapeXml(s: string) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function unescapeHtml(s: string) { return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }
function hasEnglishLeakage(_p: string) { return false; }
function loadBotConfig() { return { translationEngine: 'google' }; }
async function translateParagraphsToHindi(paras: string[], ch: number, title: string) { return { title, paragraphs: paras }; }
async function editTelegramMessage(_t: string, _c: string, _m: number, _txt: string) {}
function makeProgressBar(pct: number, len = 12) { const f = Math.round((pct / 100) * len); return '[' + '█'.repeat(f) + '░'.repeat(Math.max(0, len - f)) + ']'; }
function buildSafeNovelFilename(title: string, suffix: string, s: number, e: number, isTxt: boolean) {
  return title.replace(/[^a-z0-9]+/gi, '_') + suffix + '_' + s + '_' + e + (isTxt ? '.txt' : '.epub');
}
function buildTxtFileBuffer(title: string, author: string, chapters: any[], _url: string, _lang: string) {
  return Buffer.from(title + '\\nBy ' + author + '\\n\\n' + chapters.map((c) => c.title + '\\n' + c.paragraphs.join('\\n')).join('\\n\\n'), 'utf-8');
}
async function buildEpubZipBuffer(title: string, author: string, chapters: any[]) {
  return buildTxtFileBuffer(title, author, chapters, '', 'en');
}
function registerNovelForCallback(_info: any) { return 'tok_123'; }
function extractWtrlabNovelRef(q: string) {
  const m = q.match(/wtr-lab\\.com\\/(?:en\\/)?novel\\/(\\d+)(?:\\/([a-z0-9_-]+))?/i);
  return m ? { novelId: m[1], slug: m[2] } : null;
}

export const wtrlabDynamicNovels = new Map<string, any>();
const app = { get: (_r: string, _f: any) => {}, post: (_r: string, _f: any) => {} };
type Request = any;
type Response = any;

${extractorCode}

${catalogCode}

export class TestJobRunner {
  public cancelled = new Set<string>();
  public logs: string[] = [];

  public ensureBuildStats(job: ScrapeJob) {
    if (!job.buildStats) {
      job.buildStats = {
        totalRequested: 0,
        verifiedCount: 0,
        retryCount: 0,
        fallbackCount: 0,
        placeholderCount: 0,
        errorCount: 0,
        warnings: [],
        errors: [],
      };
    }
    return job.buildStats;
  }

  public isPlaceholderChapter(paras: string[]) {
    if (!Array.isArray(paras) || paras.length === 0) return true;
    return paras.length === 1 && /queued for (?:verification|deep verification|recovery)|could not be retrieved/i.test(paras[0]);
  }

  public pushJobLog(_job: ScrapeJob, level: string, stage: string, msg: string, ch?: number) {
    this.logs.push(\`[\${level.toUpperCase()}][\${stage}]\${ch ? ' Ch ' + ch : ''}: \${msg}\`);
  }

  public persistState(_force: boolean) {}
  public finalizeJobStats(_job: ScrapeJob) {}
  public async sendDocumentToTelegram(_t: string, _c: string, _b: Buffer, _fn: string, _cap: string) {}

${buildGateCode}
}

export class TestTelegramHandler {
  public defaultLanguage: 'en' | 'hi' = 'en';
  public defaultServiceMode: WtrlabServiceMode = 'ai';
  public defaultFormat = 'epub';
  public getServiceModeLabel(m: string) { return m.toUpperCase(); }
  public async sendPhoto(_c: string, _u: string, _m: string, _kb: any) {}
  public async sendMessage(_c: string, _m: string, _kb?: any) {}

${telegramCode.split('// --- Telegram /wtr Commands ---')[0]}
}

export {
  ensureCanonicalWtrlabSlug,
  probeWtrlabChapterSsrState,
  parseWtrlabChapterMarkdown,
  extractChapterNumberFromHeading,
  normalizeWtrlabSlotTitle,
  deduplicateChapterParagraphs,
  computeChapterFingerprint,
  scrapeWtrlabChapterClean,
};
`;

  const tmpModPath = path.join(process.cwd(), 'test/_full_suite_runner.ts');
  fs.writeFileSync(tmpModPath, fullHostTs, 'utf-8');

  const mod = await import('./_full_suite_runner.ts');

  console.log('=== 1. UNIT TESTS: Edge-Case Parser & Anti-Truncation / Anti-Skip Guards ===');

  // 1a. Roman numerals & word numbers
  if (mod.extractChapterNumberFromHeading('Chapter XIV: Blood Moon') !== 14) {
    throw new Error('Failed Roman numeral XIV extraction');
  }
  if (mod.extractChapterNumberFromHeading('Chapter Twenty-Three: The Final Trial') !== 23) {
    throw new Error('Failed English word number Twenty-Three extraction');
  }

  // 1b. Dialogue mentioning next chapter MUST NOT truncate the chapter!
  const fakeMdWithDialogue = [
    'Title: Test Novel Chapter 5',
    'URL Source: https://wtr-lab.com/en/novel/999/test-novel/chapter-5',
    'Markdown Content:',
    '**Chapter 5: Secret Manual**',
    'He opened the ancient jade scroll and read aloud.',
    '"Chapter 6 of the Heaven Sword Manual was destroyed three hundred years ago, so nobody knows its final stance!" the elder sighed.',
    'Chapter 6 of the ancient tome had indeed vanished without a trace, leaving only ashes behind in the sect vault.',
    'Yet Su Chen smiled calmly, because he had memorized every single rune in his previous life!',
    'He stepped onto the stone platform and unleashed his sword intent.',
    '**#6**',
    'Leaked next chapter paragraph that MUST be stopped!',
  ].join('\n\n');

  const parsedDialogue = mod.parseWtrlabChapterMarkdown({
    md: fakeMdWithDialogue,
    novelId: '999',
    chapterNo: 5,
    expectedNovelTitle: 'Test Novel',
    activeMode: 'ai',
  });
  if (!parsedDialogue.extracted || parsedDialogue.extracted.paragraphs.length !== 5) {
    throw new Error(`Dialogue boundary bug! Expected 5 full paragraphs, got ${parsedDialogue.extracted?.paragraphs.length}`);
  }
  console.log('  [PASS] Mid-chapter dialogue/prose mentioning "Chapter N+1..." preserved 100% intact (stopped cleanly at **#6**).');

  // 1c. Heading-less Prologue / Short Chapter MUST NOT be dropped!
  const fakeHeadinglessShort = [
    'Title: Test Novel Chapter 1',
    'URL Source: https://wtr-lab.com/en/novel/999/test-novel/chapter-1',
    'Markdown Content:',
    'Darkness.',
    'Endless, suffocating darkness enveloped the starry void before the first spark of creation ignited the firmament and awakened the ancient sovereign from his slumber.',
  ].join('\n\n');

  const parsedShort = mod.parseWtrlabChapterMarkdown({
    md: fakeHeadinglessShort,
    novelId: '999',
    chapterNo: 1,
    expectedNovelTitle: 'Test Novel',
    activeMode: 'ai',
    ssrFallbackTitle: 'Prologue: Darkness',
  });
  if (!parsedShort.extracted || parsedShort.extracted.title !== 'Chapter 1: Prologue: Darkness' || parsedShort.extracted.paragraphs.length !== 2) {
    throw new Error(`Heading-less / short chapter dropped! Got: ${JSON.stringify(parsedShort)}`);
  }
  console.log('  [PASS] Heading-less / Prologue / short 2-paragraph chapter preserved with SSR fallback title.');

  // 1d. Giant single-wall-of-text chapter auto-splitting + SSR double-mount dedup
  const wallText = 'First sentence of the chapter with plenty of words to test splitting properly. '.repeat(8);
  const splitParas = mod.deduplicateChapterParagraphs([wallText]);
  if (splitParas.length < 2) {
    throw new Error('Failed to split giant single-block chapter');
  }
  const doubled = [...splitParas, ...splitParas];
  const deduped = mod.deduplicateChapterParagraphs(doubled);
  if (deduped.length !== splitParas.length) {
    throw new Error(`Double-mount dedup failed: expected ${splitParas.length}, got ${deduped.length}`);
  }
  console.log('  [PASS] Single-block chapter splitter & SSR/CSR double-mount deduplicator verified.');

  console.log('\n=== 2. LIVE FAST SSR PROBE TEST (<1.5s Non-Existent vs Valid Chapter Detection) ===');
  const tProbe0 = Date.now();
  const badProbe = await mod.probeWtrlabChapterSsrState('7226', 'nine-dragon-god-emperor', 99999, 'high');
  const tProbe1 = Date.now();
  const goodProbe = await mod.probeWtrlabChapterSsrState('7226', 'nine-dragon-god-emperor', 11, 'high');
  const tProbe2 = Date.now();
  console.log(`  Missing Ch 99999 probe: exists=${badProbe.exists}, confirmedMissing=${badProbe.confirmedMissing} in ${tProbe1 - tProbe0}ms`);
  console.log(`  Valid Ch 11 probe: exists=${goodProbe.exists}, ssrTitle="${goodProbe.ssrTitle}" in ${tProbe2 - tProbe1}ms`);
  if (badProbe.exists || !badProbe.confirmedMissing || !goodProbe.exists) {
    throw new Error('SSR probe failed to distinguish missing vs valid chapter!');
  }

  console.log('\n=== 3. FULL END-TO-END SEQUENTIAL BATCH JOB TEST (Ch 8 -> Ch 13 across AI-to-Web+ Gate Boundary!) ===');
  // Scraping Ch 8, 9, 10, 11, 12, 13 via full executeJob + verifyAndRepairBuiltChapters!
  // This crosses the infamous Ch 10 -> Ch 11 Guest AI Registration Gate AND tests concurrent workers + 3-pass gate!
  const runner = new mod.TestJobRunner();
  const job: any = {
    id: 'job_live_batch_1',
    novelId: 'wtr_7226',
    novelUrl: 'https://wtr-lab.com/en/novel/7226/novel', // Intentionally pass generic '/novel' URL to test end-to-end canonical slug fix!
    title: '',
    author: '',
    startChapter: 8,
    totalChapters: 13,
    progress: 0,
    status: 'queued',
    format: 'txt',
    language: 'en',
    serviceMode: 'ai',
  };

  await runner.executeJob(job, 13, 'custom');

  console.log(`  Job Final Status: ${job.status} | Progress: ${job.progress}% | File Size: ${job.fileSize} bytes`);
  console.log(`  Verification Summary:`, job.buildStats.verificationSummary);

  if (job.status !== 'completed') {
    console.error('Job Logs:', runner.logs);
    throw new Error(`Batch job failed: ${job.error}`);
  }

  const builtNums = job.chapters.map((c: any) => c.num);
  console.log(`  Built Chapter Numbers: [${builtNums.join(', ')}]`);
  if (JSON.stringify(builtNums) !== JSON.stringify([8, 9, 10, 11, 12, 13])) {
    throw new Error(`Gap detected in built chapters! Expected [8,9,10,11,12,13], got ${JSON.stringify(builtNums)}`);
  }

  const hashes = new Set<string>();
  for (const c of job.chapters) {
    const fp = mod.computeChapterFingerprint(c.paragraphs);
    console.log(`    Ch ${c.num}: "${c.title}" | ${c.paragraphs.length} paras | hash=${fp.fullHash}`);
    if (!fp.fullHash || hashes.has(fp.fullHash)) {
      throw new Error(`Duplicate or empty chapter in batch output at Ch ${c.num}!`);
    }
    hashes.add(fp.fullHash);
  }

  fs.unlinkSync(tmpModPath);
  console.log('\n✅ ALL UNIT + LIVE FULL-PIPELINE ZERO-DROP & ZERO-DUPLICATE TESTS PASSED 100%!');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ SUITE FAILED:', err);
  process.exit(1);
});
