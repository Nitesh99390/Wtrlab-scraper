import JSZip from 'jszip';
import { escapeXml, USER_AGENT } from './util';
import { ChapterLike } from './types';
import { log, errMsg } from './logger';

export function buildSafeNovelFilename(title: string, suffix: string, start: number, end: number, isTxt: boolean): string {
  const base =
    String(title || 'Novel')
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 60) || 'Novel';
  return `${base}${suffix || ''}_Ch${start}-${end}.${isTxt ? 'txt' : 'epub'}`;
}

export function buildTxtFileBuffer(
  title: string,
  author: string,
  chapters: ChapterLike[],
  novelUrl: string,
  _lang: string
): Buffer {
  const lines: string[] = [title, `By ${author}`, novelUrl ? `Source: ${novelUrl}` : '', '', '='.repeat(60), ''];
  for (const c of chapters) {
    lines.push(c.title, '-'.repeat(Math.min(60, c.title.length)), '', ...c.paragraphs.flatMap((p) => [p, '']), '');
  }
  return Buffer.from(lines.join('\n'), 'utf-8');
}

async function fetchCover(coverUrl?: string): Promise<{ data: Buffer; ext: 'jpg' | 'png' | 'webp'; mime: string } | null> {
  if (!coverUrl) return null;
  const candidates = [coverUrl, `https://wsrv.nl/?url=${encodeURIComponent(coverUrl)}&output=jpg`];
  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'image/*,*/*;q=0.8', Referer: 'https://wtr-lab.com/' },
        signal: AbortSignal.timeout(9000),
      });
      if (!res.ok) continue;
      const type = (res.headers.get('content-type') || '').toLowerCase();
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length < 500 || data.length > 6 * 1024 * 1024) continue;
      if (type.includes('png')) return { data, ext: 'png', mime: 'image/png' };
      if (type.includes('webp')) return { data, ext: 'webp', mime: 'image/webp' };
      if (type.includes('jpeg') || type.includes('jpg')) return { data, ext: 'jpg', mime: 'image/jpeg' };
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

export async function buildEpubZipBuffer(
  title: string,
  author: string,
  chapters: ChapterLike[],
  novelUrl: string,
  lang: string,
  coverUrl?: string
): Promise<Buffer> {
  const l = lang === 'hi' ? 'hi' : 'en';
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
  );

  const cover = await fetchCover(coverUrl).catch((e) => {
    log.debug('[epub] cover fetch failed:', errMsg(e));
    return null;
  });
  if (cover) zip.file(`OEBPS/cover.${cover.ext}`, cover.data);

  zip.file(
    'OEBPS/style.css',
    `body{font-family:serif;line-height:1.55;margin:5%}h1,h2{text-align:center;margin:1em 0}p{margin:0 0 .9em 0;text-indent:0}`
  );

  const xhtml = (t: string, body: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${l}" xml:lang="${l}"><head><meta charset="utf-8"/><title>${escapeXml(t)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${body}</body></html>`;

  zip.file(
    'OEBPS/title.xhtml',
    xhtml(
      title,
      `<h1>${escapeXml(title)}</h1><p style="text-align:center">${escapeXml(author)}</p>${
        novelUrl ? `<p style="text-align:center;font-size:.8em">${escapeXml(novelUrl)}</p>` : ''
      }`
    )
  );

  chapters.forEach((c, i) => {
    zip.file(
      `OEBPS/ch${i + 1}.xhtml`,
      xhtml(c.title, `<h2>${escapeXml(c.title)}</h2>${c.paragraphs.map((p) => `<p>${escapeXml(p)}</p>`).join('')}`)
    );
  });

  zip.file(
    'OEBPS/nav.xhtml',
    xhtml(
      'Contents',
      `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${chapters
        .map((c, i) => `<li><a href="ch${i + 1}.xhtml">${escapeXml(c.title)}</a></li>`)
        .join('')}</ol></nav>`
    )
  );

  const uid = `urn:wtrlab:${Date.now().toString(36)}`;
  zip.file(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${uid}"/></head><docTitle><text>${escapeXml(title)}</text></docTitle><navMap>${chapters
      .map(
        (c, i) =>
          `<navPoint id="n${i + 1}" playOrder="${i + 1}"><navLabel><text>${escapeXml(c.title)}</text></navLabel><content src="ch${i + 1}.xhtml"/></navPoint>`
      )
      .join('')}</navMap></ncx>`
  );

  const manifest = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
    `<item id="css" href="style.css" media-type="text/css"/>`,
    `<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>`,
    ...(cover ? [`<item id="cover-img" href="cover.${cover.ext}" media-type="${cover.mime}" properties="cover-image"/>`] : []),
    ...chapters.map((_c, i) => `<item id="ch${i + 1}" href="ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`),
  ].join('');
  const spine = ['<itemref idref="title"/>', ...chapters.map((_c, i) => `<itemref idref="ch${i + 1}"/>`)].join('');

  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">${uid}</dc:identifier><dc:title>${escapeXml(title)}</dc:title><dc:creator>${escapeXml(author)}</dc:creator><dc:language>${l}</dc:language><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta></metadata><manifest>${manifest}</manifest><spine toc="ncx">${spine}</spine></package>`
  );

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
