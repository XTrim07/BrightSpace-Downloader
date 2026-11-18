// @vitest-environment jsdom
import { strToU8, zipSync } from 'fflate';
import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Course } from '../src/lib/model';
import { pptxText } from '../src/lib/pptx';
import type { Api } from '../src/lib/valence';
import { normalizeLinks } from '../src/lib/vault/build';
import { MemoryFS } from '../src/lib/vault/fs';
import { hubParentText, readNotes, splitMarkers, updateHub } from '../src/lib/vault/hubs';
import {
  applyPending, DEFAULT_VAULT_SETTINGS, OwnerMismatchError, runVaultSync, SyncCancelledError,
} from '../src/lib/vault/run';
import { loadManifest } from '../src/lib/vault/sync';

beforeAll(() => {
  // jsdom has no SubtleCrypto; the sync hashes notes with it.
  if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
});

// ---- a tiny .pptx ---------------------------------------------------------

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const para = (t: string) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`;
const shape = (...paras: string[]) => `<p:sp><p:nvSpPr/><p:txBody><a:bodyPr/>${paras.map(para).join('')}</p:txBody></p:sp>`;
const table = (rows: string[][]) =>
  `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>${rows.map((r) =>
    `<a:tr>${r.map((c) => `<a:tc><a:txBody>${para(c)}</a:txBody></a:tc>`).join('')}</a:tr>`).join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
const slide = (body: string) =>
  `<?xml version="1.0"?><p:sld xmlns:a="${A}" xmlns:p="${P}"><p:cSld><p:spTree><p:nvGrpSpPr/>${body}</p:spTree></p:cSld></p:sld>`;

function pptx(): Uint8Array {
  return zipSync({
    'ppt/presentation.xml': strToU8(
      `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/><p:sldId id="258" r:id="rId3"/></p:sldIdLst></p:presentation>`),
    'ppt/_rels/presentation.xml.rels': strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/>' +
      '<Relationship Id="rId3" Target="slides/slide3.xml"/></Relationships>'),
    // file order differs from presentation order on purpose
    'ppt/slides/slide1.xml': strToU8(slide(shape('Limits', 'of functions') + table([['x', 'f(x)'], ['0', '1']]))),
    'ppt/slides/slide2.xml': strToU8(slide(shape('Calculus') + shape('  '))),
    'ppt/slides/slide3.xml': strToU8(slide('<p:pic/>')),
    'ppt/media/image1.png': new Uint8Array(2000),
  });
}

describe('pptxText', () => {
  it('lists slide text in presentation order, like python-pptx', () => {
    expect(pptxText(pptx())).toBe(
      '### Slide 1\n\nCalculus\n\n### Slide 2\n\nLimits\nof functions\n\nx | f(x)\n\n0 | 1');
  });
});

describe('normalizeLinks', () => {
  it('repairs markdown links nested in wikilink brackets', () => {
    expect(normalizeLinks('See [[PDF](https://x.org/a.pdf)] and [[Real wikilink]].'))
      .toBe('See [PDF](https://x.org/a.pdf) and [[Real wikilink]].');
  });
});

// ---- a fake Brightspace course -------------------------------------------

const course: Course = { id: 42, code: 'CSE12A+2026+2', name: 'CSE12A Calculus (2026/27 Q2)' };
const le = '/d2l/api/le/1.75/42';
const NONE = { Text: '', Html: '' };

interface World {
  slidesLm: string;
  withDeck: boolean;
}

function fakeApi(world: World): Api & { gets: string[]; fetched: string[] } {
  const topic = (id: number, title: string, url: string, lm: string, link = false, described = true) => ({
    TopicId: id, Title: title, TypeIdentifier: link ? 'Link' : 'File', Url: url, SortOrder: id,
    LastModifiedDate: lm, ...(described ? { Description: NONE } : {}),
  });
  const topics = [
    topic(10, 'Slides', '/content/enforced/42/slides.pdf', world.slidesLm),
    ...(world.withDeck ? [topic(11, 'Deck', '/content/enforced/42/deck.pptx', 'd1')] : []),
    topic(12, 'Intro', '/content/enforced/42/intro.html', 'd1'),
    topic(13, 'Recording', '/content/enforced/42/rec.mp4', 'd1'),
    topic(14, 'Lecture video', 'https://youtu.be/abc12345678', 'd1', true),
    topic(15, 'Notes', '/content/enforced/42/notes.txt', 'd1', false, false),
  ];
  const toc = {
    Modules: [{
      ModuleId: 1, Title: 'Week 1', SortOrder: 1, LastModifiedDate: 'm1', Modules: [], Topics: topics,
      Description: { Html: '<p>See [[PDF](https://x.org/a.pdf)]</p>' },
    }],
  };
  const gets: string[] = [];
  const fetched: string[] = [];
  return {
    gets, fetched,
    async get(path: string) {
      gets.push(path);
      if (path === `${le}/content/toc`) return toc as any;
      if (path === `${le}/content/topics/15`) return { Description: { Text: 'read this first' } } as any;
      return null;
    },
    async fetchFile(_c, tid) {
      fetched.push(String(tid));
      const type = (t: string) => ({ headers: { 'content-type': t } });
      if (tid === 11) return new Response(pptx() as BodyInit, type('application/vnd.ms-powerpoint'));
      if (tid === 12) return new Response('<html><body><h1>Welcome</h1><p>Hello <b>there</b></p></body></html>', type('text/html'));
      if (tid === 15) return new Response('plain notes\n', type('text/plain'));
      return new Response(`PDF-${world.slidesLm}`, type('application/pdf'));
    },
  };
}

const V = 'CSE12A - Calculus';
const OUT = `Brightspace/${V}`;
const run = (fs: MemoryFS, api: Api, owner = 'aflorea') =>
  runVaultSync(api, fs, [course], DEFAULT_VAULT_SETTINGS, owner);
const vaultFiles = (fs: MemoryFS) => [...fs.files.keys()].filter((p) => !p.startsWith('.brightspace-sync/')).sort();

describe('runVaultSync', () => {
  it('writes the same vault layout as the Python pipeline, without media files', async () => {
    const fs = new MemoryFS();
    const res = await run(fs, fakeApi({ slidesLm: 'd1', withDeck: true }));
    expect(res.skippedCourses).toEqual([]);
    expect(vaultFiles(fs)).toEqual([
      '! Course Notes.md',
      '! Index.md',
      'Brightspace/! Brightspace.md',
      `${OUT}/${V}.md`,
      `${OUT}/Week 1.md`,
      `${OUT}/Week 1/Deck.md`,
      `${OUT}/Week 1/Deck.pptx`,
      `${OUT}/Week 1/Intro.md`,
      `${OUT}/Week 1/Lecture video.md`,
      `${OUT}/Week 1/Notes.md`,
      `${OUT}/Week 1/Notes.txt`,
      `${OUT}/Week 1/Slides.pdf`,
      `Courses/${V} Notebook.md`,
      `Courses/${V}.md`,
    ]);
    const week = (await fs.readText(`${OUT}/Week 1.md`))!;
    expect(week).toContain('## Contents\n\nSee [PDF](https://x.org/a.pdf)\n');
    expect(week).toContain(`- [[${V}/Week 1/Slides.pdf|Slides]]`);
    // the video file is not copied: it stays a link to Brightspace
    expect(week).toContain('- [Recording](https://brightspace.tudelft.nl/d2l/le/content/42/viewContent/13/View)');
    expect(week).toContain(`- [[${V}/Week 1/Lecture video]]`);
    expect(await fs.readText(`${OUT}/Week 1/Deck.md`)).toContain('## Contents\n\n### Slide 1\n\nCalculus\n\n### Slide 2');
    expect(await fs.readText(`${OUT}/Week 1/Intro.md`)).toContain('## Contents\n\n## Welcome\n\nHello **there**');
    expect(await fs.readText(`${OUT}/Week 1/Notes.md`)).toContain('## Contents\n\nread this first\n\nplain notes');
    expect(await fs.readText(`${OUT}/Week 1/Lecture video.md`)).toContain('[Lecture video](https://youtu.be/abc12345678)');
    expect(await fs.readText(`${OUT}/${V}.md`)).toContain(`Course hub: [[Courses/${V}]]`);

    const hub = (await fs.readText(`Courses/${V}.md`))!;
    expect(hub).toContain(`> - Brightspace: [[Brightspace/${V}/${V}]] (read-only)`);
    expect(hub).toContain('WHERE contains(codes, "CSE12A") AND date >= date(today)');
    expect(hub.endsWith('<!-- AUTO:END -->\n\n## Notes\n')).toBe(true);
    expect((await loadManifest(fs)).owner).toBe('aflorea');
  });

  it('a second sync changes nothing and downloads nothing', async () => {
    const fs = new MemoryFS();
    await run(fs, fakeApi({ slidesLm: 'd1', withDeck: true }));
    const before = new Map([...fs.files].map(([k, v]) => [k, v.mtime]));
    const api = fakeApi({ slidesLm: 'd1', withDeck: true });
    const res = await run(fs, api);
    expect(api.fetched).toEqual([]);
    expect(api.gets.filter((g) => g.includes('/content/topics/'))).toEqual([]);
    expect([res.log.added, res.log.modified, res.log.removed, res.hubs!.written]).toEqual([[], [], [], []]);
    for (const path of vaultFiles(fs)) expect(fs.files.get(path)!.mtime).toBe(before.get(path));
  });

  it('updates changed files in place and keeps the student\'s own notes', async () => {
    const fs = new MemoryFS();
    await run(fs, fakeApi({ slidesLm: 'd1', withDeck: true }));
    const hubPath = `Courses/${V}.md`;
    fs.set(hubPath, `${await fs.readText(hubPath)}\nMy exam summary\n`);

    const api = fakeApi({ slidesLm: 'd2', withDeck: true });
    const res = await run(fs, api);
    expect(api.fetched).toEqual(['10']);
    expect(res.log.modified).toEqual([`${V}/Week 1/Slides.pdf`]);
    expect(res.log.added).toEqual([]);
    expect(await fs.readText(`${OUT}/Week 1/Slides.pdf`)).toBe('PDF-d2');
    expect(await fs.readText(hubPath)).toContain('## Notes\n\nMy exam summary\n');
    // one copy of each file: the previous version only lives in the pruned backups
    expect(vaultFiles(fs).filter((p) => p.includes('Slides'))).toEqual([`${OUT}/Week 1/Slides.pdf`]);
  });

  it('never deletes or overwrites the student\'s work without asking', async () => {
    const fs = new MemoryFS();
    await run(fs, fakeApi({ slidesLm: 'd1', withDeck: true }));
    fs.set(`${OUT}/Week 1/Intro.md`, 'my own rewrite of the intro');

    const api = fakeApi({ slidesLm: 'd1', withDeck: false });
    const res = await run(fs, api);
    expect(res.pendingRemove.map((a) => a.path).sort()).toEqual([`${V}/Week 1/Deck.md`, `${V}/Week 1/Deck.pptx`]);
    expect(res.pendingEdited.map((a) => a.path)).toEqual([`${V}/Week 1/Intro.md`]);
    expect(await fs.readText(`${OUT}/Week 1/Deck.pptx`)).not.toBeNull();
    expect(await fs.readText(`${OUT}/Week 1/Intro.md`)).toBe('my own rewrite of the intro');

    const log = await applyPending(api, fs, DEFAULT_VAULT_SETTINGS, res.plan, 'remove');
    expect(log.removed.sort()).toEqual([`${V}/Week 1/Deck.md`, `${V}/Week 1/Deck.pptx`]);
    expect(await fs.readText(`${OUT}/Week 1/Deck.pptx`)).toBeNull();
    expect(await fs.readText(`${OUT}/Week 1/Intro.md`)).toBe('my own rewrite of the intro');
  });

  it('refuses to mix two Brightspace users in one vault', async () => {
    const fs = new MemoryFS();
    await run(fs, fakeApi({ slidesLm: 'd1', withDeck: true }));
    await expect(run(fs, fakeApi({ slidesLm: 'd1', withDeck: true }), 'someone-else'))
      .rejects.toBeInstanceOf(OwnerMismatchError);
  });
});

describe('course hubs', () => {
  it('regenerates only the marked block', () => {
    const hub = '---\ntitle: X\nFolders:\n  - "[[! Index]]"\n---\n# X\n\n<!-- AUTO:START -->\nold\n<!-- AUTO:END -->\n\n## Notes\n\nmine\n';
    expect(splitMarkers(hub)).toEqual(['---\ntitle: X\nFolders:\n  - "[[! Index]]"\n---\n# X\n\n', 'old', '\n## Notes\n\nmine\n']);
    expect(updateHub(hub, ['new', 'lines'])).toBe(
      '---\ntitle: X\nFolders:\n  - "[[! Course Notes]]"\n---\n# X\n\n<!-- AUTO:START -->\nnew\nlines\n<!-- AUTO:END -->\n\n## Notes\n\nmine\n');
    expect(readNotes(hub)).toBe('mine');
    expect(readNotes('# X\n\n## Notes\n')).toBe('');
  });

  it('keeps prose the student added to the grouping note', () => {
    const first = hubParentText(null, '! Index');
    expect(first.startsWith('---\ntitle: ! Course Notes\ntags: [course-index, moc, autogenerated/partial]\nFolders:\n  - "[[! Index]]"\n---\n')).toBe(true);
    const edited = first.replace('# ! Course Notes', '# ! Course Notes\n\nMy semester plan');
    const again = hubParentText(edited, '! Index');
    expect(again).toContain('My semester plan');
    expect(hubParentText(again, '! Index')).toBe(again); // stable from here on
  });
});

describe('cancel', () => {
  const runWith = (fs: MemoryFS, api: Api, signal: AbortSignal) =>
    runVaultSync(api, fs, [course], DEFAULT_VAULT_SETTINGS, 'aflorea', undefined, undefined, signal);

  it('before writing: nothing reaches the vault, what was read is cached', async () => {
    const fs = new MemoryFS();
    const stop = new AbortController();
    const base = fakeApi({ slidesLm: 'd1', withDeck: false });
    const api: Api = {
      get: base.get,
      async fetchFile(c, t) {
        stop.abort(); // pressed while pages are being read
        return base.fetchFile(c, t);
      },
    };
    await expect(runWith(fs, api, stop.signal)).rejects.toBeInstanceOf(SyncCancelledError);
    const files = [...fs.files.keys()];
    expect(files.some((f) => f.startsWith('Brightspace/'))).toBe(false);
    expect(files).toContain('.brightspace-sync/textcache.json');
    expect(await fs.readText('.brightspace-sync/manifest.json')).toBeNull();
  });

  it('while writing: stops, keeps the vault consistent, the next sync adds the rest', async () => {
    const fs = new MemoryFS();
    const stop = new AbortController();
    const base = fakeApi({ slidesLm: 'd1', withDeck: false });
    const api: Api = {
      get: base.get,
      async fetchFile(c, t) {
        if (String(t) === '10') { // the PDF is only fetched when writing
          stop.abort();
          throw new DOMException('Cancelled', 'AbortError');
        }
        return base.fetchFile(c, t);
      },
    };
    const res = await runWith(fs, api, stop.signal);
    expect(res.cancelled).toBe(true);
    expect(res.log.failed).toEqual([]);
    expect(res.hubs).toBeNull();
    expect(await fs.readText(`${OUT}/Week 1/Slides.pdf`)).toBeNull();
    const manifest = await loadManifest(fs);
    expect(manifest.files[`${V}/Week 1/Slides.pdf`]).toBeUndefined();
    expect(manifest.files[`${V}/Week 1.md`]).toBeDefined();

    const next = await run(fs, fakeApi({ slidesLm: 'd1', withDeck: false }));
    expect(next.cancelled).toBe(false);
    expect(next.log.added).toEqual([`${V}/Week 1/Slides.pdf`]);
  });
});
