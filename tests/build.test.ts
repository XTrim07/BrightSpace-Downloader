// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { htmlToMd } from '../src/lib/htmlmd';
import type { Course, ScannedCourse, Selection, TreeNode } from '../src/lib/model';
import { categoryOf } from '../src/lib/model';
import { claim, hydrate, scanCourse } from '../src/lib/scan';
import { label, sanitize } from '../src/lib/util';
import type { Api } from '../src/lib/valence';
import { addVaultHome, buildVault, courseVaultName } from '../src/lib/vault/build';

const ALL: Selection = {
  categories: { documents: true, videos: true, pages: true, links: true, other: true },
  announcements: true, assignments: true, grades: true, excluded: new Set(), maxFileMB: 0,
};

describe('sanitize / label', () => {
  it('matches the Python rules', () => {
    expect(sanitize('Week 1: Intro / Setup?')).toBe('Week 1- Intro - Setup-');
    expect(sanitize('  a   b . ')).toBe('a b');
    expect(sanitize('[draft] #1 ^x')).toBe('-draft- -1 -x');
    expect(sanitize('Q&amp;A &#39;s')).toBe("Q&A 's");
    expect(sanitize('')).toBe('untitled');
    expect(sanitize('...')).toBe('untitled');
    expect(sanitize('x'.repeat(200)).length).toBe(110);
    expect(sanitize('abc. def', 4)).toBe('abc');
  });
  it('guards Windows device names', () => {
    expect(sanitize('CON')).toBe('_CON');
    expect(sanitize('nul.txt')).toBe('_nul.txt');
    expect(sanitize('Console')).toBe('Console');
  });
  it('label is table-safe', () => {
    expect(label('a | b\n[c]')).toBe('a - b (c)');
  });
});

describe('htmlToMd', () => {
  it('renders blocks and inline markup', () => {
    const md = htmlToMd(
      '<h2>Title</h2><p>Hello <b>bold</b> and <a href="https://x.y">link [1]</a><br>next</p>' +
      '<ul><li>one<ul><li>deep</li></ul></li><li><em>two</em></li></ul>' +
      '<ol><li>a</li><li>b</li></ol><script>evil()</script>' +
      '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td></tr></table>' +
      '<iframe src="https://kaltura.example/embed/1"></iframe><hr>',
    );
    expect(md).toBe([
      '### Title',
      'Hello **bold** and [link (1)](https://x.y)\nnext',
      '- one', '  - deep', '- _two_', '1. a', '2. b',
      '| A | B |', '| --- | --- |', '| 1 |  |',
      '[embedded content](https://kaltura.example/embed/1)', '---',
    ].join('\n\n'));
  });
  it('keeps loose inline content together as a paragraph', () => {
    expect(htmlToMd('Do <b>it</b> now<div>Then <a href="u">this</a> <span>and <i>that</i></span></div><h6>deep</h6>'))
      .toBe('Do **it** now\n\nThen [this](u) and _that_\n\n###### deep');
    expect(htmlToMd('<span><p>para in span</p></span><figure><img alt="x" src="y.png"><figcaption>cap</figcaption></figure>'))
      .toBe('para in span\n\n![x](y.png)\n\ncap');
  });
  it('handles plain text and empty input', () => {
    expect(htmlToMd('just   text')).toBe('just text');
    expect(htmlToMd('')).toBe('');
    expect(htmlToMd(null)).toBe('');
  });
});

describe('claim', () => {
  it('dedupes case-insensitively and keeps known names', () => {
    const names: Record<string, string> = {};
    const taken = new Set<string>();
    expect(claim('Slides', '.pdf', 'a', names, taken)).toBe('Slides.pdf');
    expect(claim('slides', '.pdf', 'b', names, taken)).toBe('slides (2).pdf');
    // next run, different order: owners keep their names
    const again = new Set<string>();
    expect(claim('slides', '.pdf', 'b', names, again)).toBe('slides (2).pdf');
    expect(claim('Slides', '.pdf', 'a', names, again)).toBe('Slides.pdf');
  });
});

// ---- a fake Brightspace --------------------------------------------------

const course: Course = { id: 42, code: 'CSE1105+2026+1', name: 'CSE1105 Software Project (2026/27 Q1)' };

function fakeApi(): Api & { calls: string[] } {
  const le = '/d2l/api/le/1.75/42';
  const json: Record<string, unknown> = {
    [`${le}/content/root/`]: [
      { Id: 1, Title: 'Week 1: Intro', Type: 0, LastModifiedDate: 'd1', Description: { Html: '<p>Welcome <b>all</b></p>' } },
      { Id: 2, Title: 'Empty', Type: 0, LastModifiedDate: 'd1', Description: { Text: '' } },
    ],
    [`${le}/content/modules/1/structure/`]: [
      { Id: 10, Title: 'Lecture 1', Type: 1, TopicType: 1, Url: '/content/enforced/42/lec1.pdf', LastModifiedDate: 'd2', Description: { Text: '' } },
      { Id: 11, Title: 'Lecture 1', Type: 1, TopicType: 1, Url: '/content/enforced/42/lec1b.pdf', LastModifiedDate: 'd2', Description: { Text: 'second deck' } },
      { Id: 12, Title: 'Recording', Type: 1, TopicType: 3, Url: 'https://collegerama.tudelft.nl/Mediasite/Play/abc', LastModifiedDate: 'd2' },
      { Id: 13, Title: 'Quiz', Type: 1, TopicType: 3, Url: '/d2l/common/dialogs/quickLink/quickLink.d2l?ou=42', LastModifiedDate: 'd2' },
      { Id: 14, Title: 'Read me', Type: 1, TopicType: 1, Url: '/content/enforced/42/readme.html', LastModifiedDate: 'd2', Description: { Text: '' } },
      { Id: 15, Title: 'notes', Type: 1, TopicType: 1, Url: '/content/enforced/42/notes.txt', LastModifiedDate: 'd2', Description: { Text: '' } },
      { Id: 16, Title: 'Demo', Type: 1, TopicType: 1, Url: '/content/enforced/42/demo.mp4', LastModifiedDate: 'd2', Description: { Text: '' } },
    ],
    [`${le}/content/modules/2/structure/`]: [],
    [`${le}/content/topics/12`]: { Description: { Html: '' } },
    [`${le}/dropbox/folders/`]: [
      { Id: 2, Name: 'Zeta', DueDate: '2026-12-01T22:59:00Z', CustomInstructions: { Text: 'Do <b>it</b>' } },
      { Id: 1, Name: 'Alpha', DueDate: null },
    ],
    [`${le}/news/`]: [{ Title: 'Hello', StartDate: '2026-09-01T08:00:00Z', Body: { Text: 'hi', Html: '<p>hi <a href="https://youtu.be/xyz">vid</a></p>' } }],
    [`${le}/grades/values/myGradeValues/`]: [{ GradeObjectName: 'Midterm', PointsNumerator: 8, PointsDenominator: 10, Comments: { Text: '' } }],
  };
  const files: Record<string, [string, string]> = {
    '14': ['text/html', '<html><body><h1>Readme</h1><p>Body text</p></body></html>'],
    '15': ['text/plain', 'plain notes\n'],
  };
  const calls: string[] = [];
  return {
    calls,
    async get(path: string) {
      calls.push(path);
      return (json[path] ?? null) as any;
    },
    async fetchFile(_cid, tid) {
      calls.push(`file:${tid}`);
      const f = files[String(tid)];
      return f ? new Response(f[1], { headers: { 'content-type': f[0] } }) : new Response('nope', { status: 404 });
    },
  };
}

async function scanned(): Promise<ScannedCourse> {
  const api = fakeApi();
  const sc = await scanCourse(api, course, { names: {}, descs: {} });
  await hydrate(api, 42, sc.tree);
  return sc;
}

describe('scanCourse', () => {
  it('walks the tree in API order with stable names and kinds', async () => {
    const sc = await scanned();
    expect(sc.code).toBe('CSE1105+2026+1');
    expect(sc.errors).toEqual([]);
    const [week, empty] = sc.tree;
    expect(week).toMatchObject({ kind: 'module', name: 'Week 1- Intro', desc: 'Welcome **all**' });
    expect(empty).toMatchObject({ kind: 'module', name: 'Empty', children: [] });
    const kids = week.children as TreeNode[];
    expect(kids.map((k) => [k.kind, k.name ?? k.url ?? ''])).toEqual([
      ['file', 'Lecture 1.pdf'], ['file', 'Lecture 1 (2).pdf'],
      ['link', 'https://collegerama.tudelft.nl/Mediasite/Play/abc'], ['locked', '/d2l/common/dialogs/quickLink/quickLink.d2l?ou=42'],
      ['page', 'Read me.html'], ['file', 'notes.txt'], ['file', 'Demo.mp4'],
    ]);
    expect(kids[0].path).toBe('Week 1- Intro/Lecture 1.pdf');
    expect(kids.map(categoryOf)).toEqual(['documents', 'documents', 'links', null, 'pages', 'documents', 'videos']);
    expect(kids[4].text).toContain('Body text');
    expect(kids[5].bytes).toBeInstanceOf(Uint8Array);
    expect(sc.dropbox).toHaveLength(2);
    expect(sc.announcements).toContain('## Hello');
  });
});

describe('buildVault', () => {
  const opts = { outName: 'Brightspace', virtFolder: true, virtRoot: '! Index' };

  it('names course folders like the Python pipeline', () => {
    expect(courseVaultName(course.name, course.code)).toBe('CSE1105 - Software Project');
    expect(courseVaultName('Bachelor Thesis', 'B+1')).toBe('B - Bachelor Thesis');
    expect(courseVaultName('', 'X+2026')).toBe('X+2026');
  });

  it('emits notes, files and extras', async () => {
    const sc = await scanned();
    const { files, homes } = buildVault([sc], ALL, opts);
    const v = 'CSE1105 - Software Project';
    expect([...files.keys()].sort()).toEqual([
      `${v}/Announcements.md`, `${v}/Assignments.md`, `${v}/${v}.md`, `${v}/Grades.md`,
      `${v}/Week 1- Intro.md`,
      `${v}/Week 1- Intro/Demo.mp4`, `${v}/Week 1- Intro/Lecture 1.md`,
      `${v}/Week 1- Intro/Lecture 1 (2).pdf`, `${v}/Week 1- Intro/Lecture 1.pdf`,
      `${v}/Week 1- Intro/Read me.md`, `${v}/Week 1- Intro/Recording.md`,
      `${v}/Week 1- Intro/notes.md`, `${v}/Week 1- Intro/notes.txt`,
    ].sort());
    expect(homes).toEqual([{ code: sc.code, vname: v, entries: 5, files: 4 }]);
    const text = (p: string) => (files.get(p) as { text: string }).text;

    expect(text(`${v}/Week 1- Intro.md`)).toBe(`---
up: [[${v}/${v}]]
Folders:
  - "[[${v}/${v}]]"
tags: [brightspace, autogenerated]
course_code: CSE1105+2026+1
brightspace_id: 1
---
<!-- auto-generated by main.py : do not edit, safe to re-run -->

# Week 1: Intro

<!-- AUTO:START -->
## Contents

Welcome **all**

## MOC

- [[${v}/Week 1- Intro/Lecture 1.pdf|Lecture 1]]
- [[${v}/Week 1- Intro/Lecture 1]]
- [[${v}/Week 1- Intro/Recording]]
- [Quiz](https://brightspace.tudelft.nl/d2l/le/content/42/viewContent/13/View)
- [[${v}/Week 1- Intro/Read me]]
- [[${v}/Week 1- Intro/notes]]
- [[${v}/Week 1- Intro/Demo.mp4|Demo]]
<!-- AUTO:END -->
`);
    expect(text(`${v}/Week 1- Intro/Read me.md`)).toContain('## Contents\n\n## Readme\n\nBody text');
    expect(text(`${v}/Week 1- Intro/notes.md`)).toContain('plain notes');
    expect(text(`${v}/${v}.md`)).toContain(
      '- [Empty](https://brightspace.tudelft.nl/d2l/le/content/42/Home)\n' +
      `- [[${v}/Assignments]]\n- [[${v}/Grades]]\n- [[${v}/Announcements]]`);
    expect(text(`${v}/${v}.md`)).toContain(`up: [[Brightspace/! Brightspace]]`);
    expect(text(`${v}/${v}.md`)).toContain(`Course hub: [[Courses/${v}]]`);
    expect(text(`${v}/Assignments.md`)).toBe(`---
up: [[${v}/${v}]]
Folders:
  - "[[${v}/${v}]]"
tags: [brightspace, autogenerated]
course_code: CSE1105+2026+1
---
<!-- auto-generated by main.py : do not edit, safe to re-run -->
<!-- AUTO:START -->
# Assignments — CSE1105+2026+1

| Name | Due | Details |
| --- | --- | --- |
| Alpha |  |  |
| Zeta | 2026-12-01 | Do **it** |
<!-- AUTO:END -->
`);
    expect(text(`${v}/Grades.md`)).toContain('| Midterm | 8 / 10 |  |');
    const ann = text(`${v}/Announcements.md`);
    expect(ann.startsWith(`---\nup: [[${v}/${v}]]`)).toBe(true);
    expect(ann).toContain('tags: [brightspace, announcements, autogenerated]');
    expect(ann).toContain('# Announcements — CSE1105+2026+1 CSE1105 Software Project (2026/27 Q1)');
    expect(ann.endsWith('[vid](https://youtu.be/xyz)\n<!-- AUTO:END -->\n')).toBe(true);
  });

  it('honours category checkboxes and unticked nodes', async () => {
    const sc = await scanned();
    const sel: Selection = {
      ...ALL,
      categories: { ...ALL.categories, videos: false, links: false },
      grades: false,
      excluded: new Set(['42:t11']),
    };
    const { files } = buildVault([sc], sel, opts);
    const keys = [...files.keys()].join('\n');
    expect(keys).not.toContain('Demo.mp4');
    expect(keys).not.toContain('Recording');
    expect(keys).not.toContain('Lecture 1 (2)');
    expect(keys).not.toContain('Grades.md');
    expect(keys).toContain('Lecture 1.pdf');
  });

  it('keeps unscanned courses in the top note', async () => {
    const sc = await scanned();
    const build = buildVault([sc], ALL, opts);
    const all = addVaultHome(build,
      { OLD: { code: 'OLD', vname: 'OLD - Thing', entries: 3, files: 2 },
        [sc.code]: { code: sc.code, vname: 'stale', entries: 0, files: 0 } },
      [sc.code], opts, '2026-11-12');
    expect(all.map((h) => h.code)).toEqual(['OLD', sc.code]);
    const top = (build.files.get('! Brightspace.md') as { text: string }).text;
    expect(top).toContain('up: [[! Index]]');
    expect(top).toContain('Synced 2026-11-12.');
    expect(top).toContain('- [[OLD - Thing/OLD - Thing|OLD]] — 3 entries, 2 files');
    expect(top).toContain('- [[CSE1105 - Software Project/CSE1105 - Software Project|CSE1105+2026+1]] — 5 entries, 4 files');
  });
});
