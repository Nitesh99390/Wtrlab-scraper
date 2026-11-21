/**
 * Offline regression tests (no network). Run: npm run test:offline
 * Guards the "Ch 404: Missing/placeholder chapter body" bug: a valid chapter whose page <title> contains the
 * chapter NUMBER 404 (or 1404 / 4040 ...) was misdetected as an HTTP-404 page and blocked the whole delivery.
 */
import express from 'express';
import { createWtrlabCore } from '../backend/generated/wtrlab_core';

const core = createWtrlabCore(express());
const { parseWtrlabChapterMarkdown: parse } = core.internals;

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

// Genuine 404 pages must still be detected
check('Jina "Target URL returned error 404" detected', run('Title: x\n\nWarning: Target URL returned error 404: Not Found\n', 3).is404);
check('"404 Page Not Found" title (tiny body) detected', run('Title: 404 Page Not Found - WTR-LAB\n\nURL Source: https://wtr-lab.com/x\n\nMarkdown Content:\nNothing here\n', 3).is404);
check('"Title: 404" (tiny body) detected', run('Title: 404\n\nMarkdown Content:\nNot found\n', 3).is404);

// Wrong chapter must never be accepted
check('Ch 405 page rejected when Ch 404 requested', !run(chapterMd(405), 404).extracted);

console.log(failed ? `\n${failed} test(s) FAILED` : '\nAll offline tests passed');
process.exit(failed ? 1 : 0);
