/**
 * Offline regression tests (no network). Run: npm run test:offline
 * Guards:
 *  1. "Ch 404: Missing/placeholder chapter body" bug (chapter numbers 404, 1404, 4040... & normalizeJinaBaseUrl stripping ?service=...)
 *  2. Novel metadata Markdown fallback parser (extracts exact 235 chapters, Completed status, author "Ren Jian Huang Tang Ke", cover & slug when SSR HTML fails)
 *  3. Ad-tracker / poisoned cache detector (adform.net, monetixads, admatic.de, tacker probe)
 *  4. Fullpage-no-wait fallback parser (ignores site H1 matching novel title while preserving exact chapter heading & body)
 */
import express from 'express';
import { createWtrlabCore } from '../backend/generated/wtrlab_core';
import { clearTrackedIntervals } from '../backend/util';

const core = createWtrlabCore(express());
const {
  parseWtrlabChapterMarkdown: parse,
  normalizeJinaBaseUrl,
  parseWtrlabNovelMarkdownFallback,
  isJinaPoisonedOrAdTrackerPayload,
} = core.internals;

const NOVEL = 'Record of Cultivation in Green Mountain, But with Ai';
const slug = 'record-of-cultivation-in-green-mountain-but-with-ai';
const body = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1}: the young cultivator walked along the quiet mountain road and thought about the dao.`).join('\n\n');

const chapterMd = (n: number, title = `${NOVEL} Chapter ${n}`) =>
  `Title: ${title}\n\nURL Source: https://wtr-lab.com/en/novel/117512/${slug}/chapter-${n}?service=web\n\nMarkdown Content:\nChapter ${n} Some Heading\n\n${body}\n`;

let failed = 0;
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failed++;
};
const run = (md: string, n: number, mode: 'web' | 'webplus' | 'ai' = 'web') =>
  parse({ md, novelId: '117512', chapterNo: n, expectedNovelTitle: NOVEL, activeMode: mode });

for (const n of [404, 1404, 2404, 4040, 404404, 5, 545]) {
  const r = run(chapterMd(n), n);
  check(`Ch ${n}: valid chapter extracted, not flagged 404`, !r.is404 && !!r.extracted && r.extracted.paragraphs.length >= 25);
}

// Title like "Room 404" with a long body must still be extracted (body is substantial)
{
  const md = `Title: Room 404 Chapter 7\n\nURL Source: https://wtr-lab.com/en/novel/9/room-404/chapter-7?service=web\n\nMarkdown Content:\nChapter 7 Door\n\n${body}\n`;
  const r = parse({ md, novelId: '9', chapterNo: 7, expectedNovelTitle: 'Room 404', activeMode: 'web' });
  check('novel titled "Room 404": chapter 7 extracted', !r.is404 && !!r.extracted);
}

// Fullpage-no-wait fallback where `# Novel Title` appears before `Chapter 404 ...`
{
  const fullpageMd = `Title: ${NOVEL} Chapter 404\n\nURL Source: https://wtr-lab.com/en/novel/117512/${slug}/chapter-404?service=webplus&_cb=123\n\nMarkdown Content:\n# ${NOVEL}\n\nChapter 404 A Distinguished Guest Arrives at Qing's Brothel\n\n${body}\n`;
  const r = parse({ md: fullpageMd, novelId: '117512', chapterNo: 404, expectedNovelTitle: NOVEL, activeMode: 'webplus' });
  check('Fullpage-no-wait H1 novel title ignored & Ch 404 extracted cleanly', !r.is404 && !!r.extracted && r.extracted.paragraphs.length >= 25);
}

// normalizeJinaBaseUrl unifies ?service=webplus / ?service=web / &_cb=... so stale 404 entries are cleared across all modes
{
  const baseExpected = `https://wtr-lab.com/en/novel/117512/${slug}/chapter-404`;
  check(
    'normalizeJinaBaseUrl strips ?service=webplus&_cb=...',
    normalizeJinaBaseUrl(`${baseExpected}?service=webplus&_cb=1700000`) === baseExpected &&
      normalizeJinaBaseUrl(`${baseExpected}?service=web`) === baseExpected
  );
}

// Novel #94959 Markdown fallback metadata parser (guards against 100-chapter / WTR-Lab Author / Ongoing fallback!)
{
  const sample94959Md = [
    "Title: Read Please Stop Making Things Up; I'm Really a Good Person RAW English Translation - WTR-LAB",
    '',
    'URL Source: https://wtr-lab.com/en/novel/94959/please-stop-making-things-up-im-really-a-good-person',
    '',
    'Markdown Content:',
    "# Please Stop Making Things Up; I'm Really a Good Person",
    '',
    '![Image 1](https://wtr-lab.com/api/v2/img?src=s3%3A%2F%2Fwtrimg%2Fseries%2F823kGouAFAui8UWumQZEhSlkpkTaz4sn0tUgKCKTMQk.jpg&w=344)',
    '',
    'Status',
    '',
    'Completed',
    '',
    'Views 4.45K',
    '',
    'Chapters 235',
    '',
    'AI-Unlock Progress',
    '',
    '235/235',
    '',
    'Novel Summary',
    '',
    'After transmigrating to another world, Fang Hao was bound to a Good Deeds System.',
    '',
    'Details',
    '',
    'Author',
    '',
    '[人间荒唐客](https://wtr-lab.com/en/author/%E4%BA%BA%E9%97%B4%E8%8D%92%E5%94%90%E5%AE%A2)[Ren Jian Huang Tang Ke](https://wtr-lab.com/en/author/%E4%BA%BA%E9%97%B4%E8%8D%92%E5%94%90%E5%AE%A2)',
  ].join('\n');

  const meta = parseWtrlabNovelMarkdownFallback(sample94959Md, '94959');
  check(
    'Novel #94959 Markdown fallback extracts 235 chapters, Completed, Ren Jian Huang Tang Ke, and cover',
    !!meta &&
      meta.chaptersCount === 235 &&
      meta.status === 'Completed' &&
      meta.author === 'Ren Jian Huang Tang Ke' &&
      meta.slug === 'please-stop-making-things-up-im-really-a-good-person' &&
      meta.coverUrl.includes('wtr-lab.com/api/v2/img')
  );
}

// Ad-tracker poison detector
check(
  'Adform tracker probe HTML/MD detected as poisoned cache',
  isJinaPoisonedOrAdTrackerPayload('<title>https://c1.adform.net/cookie</title><p>A 1x1 image, likely be a tacker probe</p>')
);

// Genuine 404 pages must still be detected
check('Jina "Target URL returned error 404" detected', run('Title: x\n\nWarning: Target URL returned error 404: Not Found\n', 3).is404);
check('"404 Page Not Found" title (tiny body) detected', run('Title: 404 Page Not Found - WTR-LAB\n\nURL Source: https://wtr-lab.com/x\n\nMarkdown Content:\nNothing here\n', 3).is404);
check('"Title: 404" (tiny body) detected', run('Title: 404\n\nMarkdown Content:\nNot found\n', 3).is404);

// Wrong chapter must never be accepted
check('Ch 405 page rejected when Ch 404 requested', !run(chapterMd(405), 404).extracted);

clearTrackedIntervals();
console.log(failed ? `\n${failed} test(s) FAILED` : '\nAll offline tests passed');
process.exit(failed ? 1 : 0);
