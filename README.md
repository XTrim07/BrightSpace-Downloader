# Brightspace Downloader (TU Delft)

Unofficial Chrome/Edge extension: download the content of a Brightspace
course as one `.zip`, straight from a popup on the Brightspace tab.

No AI is involved. The extension reads how the course is arranged on
Brightspace (through the same API the site itself uses) and copies that
arrangement: chapters become folders, files stay as they are.

## Install

```bash
npm install
npm run build
```

Open `chrome://extensions`, switch on **Developer mode**, click
**Load unpacked** and pick `.output/chrome-mv3`. After a rebuild, press the
reload icon on the extension card and reload the Brightspace tab.

## Use

1. Open Brightspace and log in. Any page works, including the home page.
2. Click the extension icon. The popup lists your courses; on a course page
   that course comes first and is already expanded.
3. Expand a course (`›`) to see its chapters, and a chapter to see its files
   and videos. Tick whole courses, chapters, or single items.
4. Options below the tree:
   - **Grades** — one `Grades.md` per course in the download
   - **Announcements** — one `Announcements.md` per course
   - **Video links** — shows videos in the tree; ticked ones are written to
     a `Links.md` in their chapter
5. Click **Download X items**. X counts the folders that have something
   ticked (plus Grades/Announcements), not the number of files.

One course gives `<Course>.zip`; several give one zip with a folder per course.

You can close the popup while it runs: a small box in the corner of the
Brightspace page shows progress. Keep that tab open until it says *Done*.

## What is in the zip

```
CSE11C Computer Organisation (2026-27 Q1)/
├── Content/
│   ├── Course Information/
│   │   └── …
│   └── Week 1- History & Assembly/
│       ├── Lectures/
│       │   ├── Lecture 0 - CO Introduction.pdf
│       │   └── Lecture 1 - History.pdf
│       └── Links.md            only if this chapter has links
├── Announcements.md
└── Grades.md
```

- Folders follow the Brightspace chapters, in the same nesting.
- Videos are never downloaded. With **Video links** ticked, YouTube topics
  are saved as plain links (`https://www.youtube.com/watch?v=…`) in the
  `Links.md` of the chapter they belong to.
- Quizzes and external tools are not downloadable and are not listed.
- A chapter without links gets no `Links.md`; an empty chapter gets no folder.
- If a file could not be fetched, `Failed downloads.txt` lists it.

## Obsidian

*Obsidian vault sync ↗* at the bottom of the popup opens a separate tab for
writing a course into an Obsidian vault (preview, backup, undo). It works
independently of the zip download and is not the current focus.

## Limits

- Not yet run against live Brightspace: the logic is covered by unit tests
  with a simulated course. If the popup shows no chapters or an error, the
  message in the popup says which request failed.
- The whole zip is built in the tab's memory before it is saved. Fine for
  slides and documents; a course with gigabytes of uploaded video files may
  be too much.
- Requests are throttled (about 4 per second, one at a time).

## Development

```bash
npm test            # unit tests (vitest)
npm run typecheck
npm run dev         # browser with hot reload
```

```
src/entrypoints/popup/        the popup (checkboxes, chapter tree, button)
src/entrypoints/content.ts    runs in the Brightspace tab: scan, fetch, zip
src/entrypoints/dashboard/    separate tab for Obsidian vault sync
src/lib/valence.ts            throttled read-only Brightspace API client
src/lib/scan.ts               course structure -> tree of chapters and topics
src/lib/zipexport.ts          zip layout, Links.md, Announcements.md, Grades.md
src/lib/htmlmd.ts             HTML -> Markdown (announcements)
src/lib/vault/                Obsidian sync (notes, plan/apply/undo)
```

## Fair use

For your own courses only. Do not redistribute downloaded material: it
belongs to TU Delft and the course staff. The extension only reads; it never
changes anything on Brightspace and never sees your password.
