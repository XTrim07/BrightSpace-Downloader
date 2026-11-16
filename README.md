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

**Export to Obsidian** keeps a copy of your courses up to date inside an
Obsidian vault, in the layout of
[CSE-vault-sync](https://github.com/vVic1029v/CSE-vault-sync). The sync
runs in its own tab (a popup closes as soon as it loses focus).

**Set up once.** The first press of *Export to Obsidian* (or the gear icon)
opens the sync page: choose the vault folder, tick the courses to keep in
sync, press *Sync now*.

**Afterwards** every press of *Export to Obsidian* opens the page and the
sync starts by itself. If something is missing, the page says what: Chrome
wants access to the folder confirmed again (one click; pick "Allow on every
visit" to avoid it), the vault folder was moved, or you are logged out of
Brightspace.

**What ends up in the vault**

```
<vault>/
├── Brightspace/                      mirror of Brightspace, do not edit
│   ├── ! Brightspace.md              top note listing the courses
│   └── CSE12A - Calculus/
│       ├── CSE12A - Calculus.md      course home (MOC)
│       ├── Week 1.md                 one note per chapter: Contents + MOC
│       ├── Week 1/
│       │   ├── Lecture slides.pdf    original files next to the notes
│       │   ├── Deck.pptx + Deck.md   slide text is extracted into a note
│       │   └── Intro.md              Brightspace pages become Markdown
│       ├── Assignments.md · Grades.md · Announcements.md
├── Courses/                          your side: write your notes here
│   ├── CSE12A - Calculus.md          hub: AUTO block + your `## Notes`
│   └── CSE12A - Calculus Notebook.md
├── ! Course Notes.md                 groups the hubs
└── .brightspace-sync/                state, hidden from Obsidian
```

- Nothing is duplicated: a sync adds what is new and updates what changed,
  in place. An unchanged course costs a handful of requests and writes
  nothing.
- Video and audio files are not copied; they stay a link to Brightspace.
  YouTube topics become a note with the link.
- Never automatic: deleting files that disappeared from Brightspace, and
  overwriting notes you edited inside `Brightspace/`. Both are listed after
  the sync with a button to confirm.
- Files that get overwritten or removed are backed up first under
  `.brightspace-sync/backups/` (last three syncs only). *Undo last sync*
  restores them.
- Hub notes: only the block between the `AUTO` markers is regenerated; your
  text is kept. The hub's class table needs the Dataview plugin and a
  `Timetable/` folder, which this extension does not create.
- One vault belongs to one Brightspace account; a different account is
  refused instead of mixing two people's courses.

Not ported from CSE-vault-sync: the timetable mirror (it reads MyTimetable,
not Brightspace) and the AGENT-SUMMARY dashboards.

## Limits

- The Obsidian sync has not been run against live Brightspace yet. It reads
  Brightspace directly from the extension page (not through the course tab,
  like the zip download does); if the page says you are not logged in while
  you are, that is the part to look at.
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
src/entrypoints/sync/         Obsidian sync page (setup once, then one click)
src/lib/valence.ts            throttled read-only Brightspace API client
src/lib/scan.ts               course structure -> tree of chapters and topics
src/lib/zipexport.ts          zip layout, Links.md, Announcements.md, Grades.md
src/lib/htmlmd.ts             HTML -> Markdown (announcements)
src/lib/pptx.ts               slide text of .pptx decks
src/lib/vault/build.ts        notes + MOCs in the CSE-vault-sync layout
src/lib/vault/hubs.ts         Courses/ hub notes (user text preserved)
src/lib/vault/sync.ts         compare / apply / undo, manifest, backups
src/lib/vault/run.ts          the one-click sync
```

## Fair use

For your own courses only. Do not redistribute downloaded material: it
belongs to TU Delft and the course staff. The extension only reads; it never
changes anything on Brightspace and never sees your password.
