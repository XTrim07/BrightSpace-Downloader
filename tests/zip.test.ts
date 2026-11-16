// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { Course } from '../src/lib/model';
import { loadExtras, scanCourse } from '../src/lib/scan';
import type { Api } from '../src/lib/valence';
import type { TreeItem } from '../src/lib/messages';
import { countFolders, leafIds, tickState } from '../src/lib/selection';
import {
  exportEntries, plainVideoUrl, videoLinksIn,
  type ExportOptions, type ExportReport,
} from '../src/lib/zipexport';

const course: Course = { id: 860447, code: 'CSE11C+2026+1', name: 'CSE11C Computer Organisation (2026/27 Q1)' };
const le = '/d2l/api/le/1.75/860447';

/** A course shaped like the real one: chapters, sub-chapters, files, YouTube topics. */
function fakeApi(): Api & { calls: string[] } {
  const toc = {
    Modules: [
      {
        ModuleId: 1, Title: 'Course Information', SortOrder: 1, Modules: [],
        Topics: [{ TopicId: 10, Title: 'Study guide', TypeIdentifier: 'File', Url: '/content/enforced/860447/guide.pdf', SortOrder: 1 }],
      },
      {
        ModuleId: 2, Title: 'Week 1: History & Assembly', SortOrder: 2,
        Description: { Html: '<p>Intro</p><iframe src="https://www.youtube.com/embed/INTRO123"></iframe>' },
        Modules: [{
          ModuleId: 3, Title: 'Lectures', SortOrder: 2, Modules: [],
          Topics: [
            { TopicId: 20, Title: 'Lecture 0 - CO Introduction', TypeIdentifier: 'File', Url: '/content/enforced/860447/lec0.pdf', SortOrder: 1, LastModifiedDate: '2026-09-01T10:00:00Z' },
            { TopicId: 21, Title: 'Lecture 1 - History', TypeIdentifier: 'File', Url: '/content/enforced/860447/lec1.pptx', SortOrder: 2 },
          ],
        }],
        Topics: [
          { TopicId: 22, Title: 'Assembly I: Intro', TypeIdentifier: 'Link', Url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA&t=10s', SortOrder: 1 },
          { TopicId: 23, Title: 'Assembly II', TypeIdentifier: 'Link', Url: 'https://youtu.be/BBBBBBBBBBB', SortOrder: 3 },
          { TopicId: 24, Title: 'Week quiz', TypeIdentifier: 'Link', Url: '/d2l/common/dialogs/quickLink/quickLink.d2l?ou=860447&type=quiz&rcode=x', SortOrder: 4 },
          { TopicId: 25, Title: 'Overview', TypeIdentifier: 'File', Url: '/content/enforced/860447/overview.html', SortOrder: 5 },
        ],
      },
      {
        ModuleId: 4, Title: 'Logic Circuits', SortOrder: 3, Modules: [],
        Topics: [{ TopicId: 30, Title: 'Broken', TypeIdentifier: 'File', Url: '/content/enforced/860447/broken.pdf', SortOrder: 1 }],
      },
    ],
  };
  const calls: string[] = [];
  return {
    calls,
    async get(path: string) {
      calls.push(path);
      if (path === `${le}/content/toc`) return toc as any;
      if (path === `${le}/news/`) return [{ Title: 'Lab Points', StartDate: '2026-11-11T13:00:00Z', Body: { Html: '<p>Dear students,</p>' } }] as any;
      if (path === `${le}/grades/values/myGradeValues/`) return [{ GradeObjectName: 'Lab 1', PointsNumerator: 9, PointsDenominator: 10 }] as any;
      return null;
    },
    async fetchFile(_cid, tid) {
      calls.push(`file:${tid}`);
      if (tid === 30) return new Response('no', { status: 404 });
      if (tid === 25) {
        return new Response('<html><body><iframe src="https://www.youtube-nocookie.com/embed/CCCCCCCCCCC?rel=0"></iframe></body></html>',
          { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      return new Response(`DATA-${tid}`, { headers: { 'content-type': 'application/pdf' } });
    },
  };
}

const ALL = ['10', '20', '21', '22', '23', '24', '25', '30'];

async function run(opts: Partial<ExportOptions> = {}) {
  const api = fakeApi();
  const sc = await scanCourse(api, course, { names: {}, descs: {} }, () => {}, { fast: true });
  const scanCalls = [...api.calls];
  await loadExtras(api, sc, { announcements: true, grades: true });
  const extraCalls = api.calls.slice(scanCalls.length);
  const report: ExportReport = { files: 0, links: 0, failed: [] };
  const files: Record<string, string> = {};
  const options: ExportOptions = { links: true, announcements: true, grades: true, selected: new Set(ALL), ...opts };
  for await (const e of exportEntries(sc, options, api, report)) {
    files[e.name] = e.input instanceof Response ? await e.input.text()
      : typeof e.input === 'string' ? e.input : new TextDecoder().decode(e.input);
  }
  return { sc, files, report, scanCalls, extraCalls, options };
}

const ROOT = 'CSE11C Computer Organisation (2026-27 Q1)';

describe('video links', () => {
  it('reduces player addresses to the plain link', () => {
    expect(plainVideoUrl('https://www.youtube.com/embed/abc123XYZ_-?start=5')).toBe('https://www.youtube.com/watch?v=abc123XYZ_-');
    expect(plainVideoUrl('https://youtu.be/abc123XYZ_-')).toBe('https://www.youtube.com/watch?v=abc123XYZ_-');
    expect(plainVideoUrl('https://www.youtube.com/watch?list=x&amp;v=abc123XYZ_-')).toBe('https://www.youtube.com/watch?v=abc123XYZ_-');
    expect(plainVideoUrl('https://example.org/page')).toBe('https://example.org/page');
    expect(videoLinksIn('<a href="https://tudelft.nl">x</a> <iframe src="https://youtu.be/abc123XYZ_-"></iframe>'))
      .toEqual(['https://www.youtube.com/watch?v=abc123XYZ_-']);
  });
});

describe('zip export', () => {
  it('scans the whole course with one content request', async () => {
    const { scanCalls, extraCalls } = await run();
    expect(scanCalls).toEqual([`${le}/content/toc`]);
    // announcements and grades are only fetched when a download wants them
    expect(extraCalls).toEqual([
      `${le}/news/`, `${le}/grades/values/myGradeValues/`, `${le}/grades/`, `${le}/grades/categories/`,
    ]);
  });

  it('mirrors the Brightspace chapters, with Links.md only where there are links', async () => {
    const { files, report } = await run();
    expect(Object.keys(files)).toEqual([
      `${ROOT}/Content/Course Information/Study guide.pdf`,
      `${ROOT}/Content/Week 1- History & Assembly/Overview.html`,
      `${ROOT}/Content/Week 1- History & Assembly/Links.md`,
      `${ROOT}/Content/Week 1- History & Assembly/Lectures/Lecture 0 - CO Introduction.pdf`,
      `${ROOT}/Content/Week 1- History & Assembly/Lectures/Lecture 1 - History.pptx`,
      `${ROOT}/Announcements.md`,
      `${ROOT}/Grades.md`,
      `${ROOT}/Failed downloads.txt`,
    ]);
    expect(files[`${ROOT}/Content/Week 1- History & Assembly/Links.md`]).toBe([
      '# Video links — Week 1: History & Assembly',
      '',
      '- [Week 1: History & Assembly](https://www.youtube.com/watch?v=INTRO123)',
      '- [Assembly I: Intro](https://www.youtube.com/watch?v=AAAAAAAAAAA)',
      '- [Assembly II](https://www.youtube.com/watch?v=BBBBBBBBBBB)',
      '- [Overview](https://www.youtube.com/watch?v=CCCCCCCCCCC)',
      '',
    ].join('\n'));
    expect(files[`${ROOT}/Content/Week 1- History & Assembly/Lectures/Lecture 0 - CO Introduction.pdf`]).toBe('DATA-20');
    expect(files[`${ROOT}/Announcements.md`]).toBe(
      `# Announcements — ${course.name}\n\n## Lab Points\n*2026-11-11T13:00:00Z*\n\nDear students,\n`);
    expect(files[`${ROOT}/Grades.md`]).toBe(
      `# Grades — ${course.name}\n\n| Grade Item | Points | Grade | Comments |\n| --- | --- | --- | --- |\n| Lab 1 | 9 / 10 |  |  |\n`);
    expect(files[`${ROOT}/Failed downloads.txt`]).toContain('Logic Circuits/Broken.pdf\thttp-404');
    expect(report).toMatchObject({ files: 4, links: 4 });
  });

  it('exports only the ticked items', async () => {
    // one video out of a whole week
    const one = await run({ announcements: false, grades: false, selected: new Set(['23']) });
    expect(Object.keys(one.files)).toEqual([`${ROOT}/Content/Week 1- History & Assembly/Links.md`]);
    expect(one.files[`${ROOT}/Content/Week 1- History & Assembly/Links.md`]).toContain('[Assembly II](https://www.youtube.com/watch?v=BBBBBBBBBBB)');
    expect(one.files[`${ROOT}/Content/Week 1- History & Assembly/Links.md`]).not.toContain('AAAAAAAAAAA');
    expect(one.report).toMatchObject({ files: 0 });

    // videos ticked but 'Video links' off: nothing is written for them
    const noLinks = await run({ links: false, announcements: false, grades: false, selected: new Set(['20', '22', '25']) });
    expect(Object.keys(noLinks.files)).toEqual([
      `${ROOT}/Content/Week 1- History & Assembly/Overview.html`,
      `${ROOT}/Content/Week 1- History & Assembly/Lectures/Lecture 0 - CO Introduction.pdf`,
    ]);

    // nothing ticked, only Grades
    const grades = await run({ announcements: false, selected: new Set() });
    expect(Object.keys(grades.files)).toEqual([`${ROOT}/Grades.md`]);
  });
});

describe('popup selection', () => {
  const items: TreeItem[] = [
    { id: '1', kind: 'folder', title: 'Course Information', children: [{ id: '10', kind: 'file', title: 'Study guide', tag: 'pdf' }] },
    {
      id: '2', kind: 'folder', title: 'Week 1', children: [
        { id: '22', kind: 'video', title: 'Assembly I' },
        { id: '3', kind: 'folder', title: 'Lectures', children: [
          { id: '20', kind: 'file', title: 'Lecture 0', tag: 'pdf' }, { id: '21', kind: 'file', title: 'Lecture 1', tag: 'pptx' },
        ] },
      ],
    },
    { id: '4', kind: 'folder', title: 'Empty', children: [] },
  ];

  it('lists tickable items; videos only with Video links on', () => {
    expect(leafIds(items, true)).toEqual(['10', '22', '20', '21']);
    expect(leafIds(items, false)).toEqual(['10', '20', '21']);
    expect(tickState(items, new Set(['20', '22']), true)).toEqual({ on: 2, total: 4 });
    expect(tickState(items, new Set(['20', '22']), false)).toEqual({ on: 1, total: 3 });
  });

  it('counts folders with something ticked, not files', () => {
    expect(countFolders(items, new Set(), true)).toBe(0);
    expect(countFolders(items, new Set(['20', '21']), true)).toBe(1); // Lectures
    expect(countFolders(items, new Set(['22']), true)).toBe(1); // Week 1
    expect(countFolders(items, new Set(['22']), false)).toBe(0); // videos hidden
    expect(countFolders(items, new Set(['10', '22', '20', '21']), true)).toBe(3);
  });
});
