# Brightspace Downloader (TU Delft)

Unofficial Chrome / Edge extension for [TU Delft Brightspace](https://brightspace.tudelft.nl).
It does two things:

1. **Download**: tick courses, chapters or single files in a popup and get
   them as one `.zip`, laid out like the course itself.
2. **Export to Obsidian**: keep your courses mirrored in an
   [Obsidian](https://obsidian.md) vault, with a note per chapter, a hub per
   course for your own notes, and your class timetable as a calendar.

No AI is involved. The extension reads how a course is arranged on
Brightspace, through the same API the website itself uses, and copies that
arrangement. It only reads: nothing is ever changed on Brightspace.

---

## Contents

- [Install](#install)
- [Download a course as a zip](#download-a-course-as-a-zip)
- [Export to Obsidian](#export-to-obsidian)
- [Calendar](#calendar)
- [How it works](#how-it-works)
- [Privacy](#privacy)
- [Limits](#limits)
- [Development](#development)
- [Fair use](#fair-use)

---

## Install

You need [Node.js](https://nodejs.org) (current LTS) and Chrome or Edge.

```bash
git clone <this repository>
cd BrightSpace-Extension-TUD
npm install
npm run build
```

1. Open `chrome://extensions` (or `edge://extensions`).
2. Switch on **Developer mode**.
3. Click **Load unpacked** and choose the folder `.output/chrome-mv3`.

After pulling changes: run `npm run build` again, press the reload icon on
the extension card, and reload the Brightspace tab.

---

## Download a course as a zip

1. Log in to Brightspace. Any page works, including the home page.
2. Click the extension icon. The popup lists your courses. On a course page,
   that course comes first and is already expanded. Courses with nothing to
   download are hidden.
3. Expand a course (`›`) to see its chapters, and a chapter to see its files
   and videos. Tick whole courses, chapters or single items.
   **Select all** and **Collapse all** work on the whole tree.
4. Options below the tree:
   - **Grades**: a `Grades.md` per course, grouped by category like the
     Grades page (item, points, grade, comments).
   - **Announcements**: an `Announcements.md` per course.
   - **Video links**: shows videos in the tree. The ones you tick are
     written as plain links to a `Links.md` in their chapter.
5. Click **Download X items**. X counts the folders with something ticked
   (plus Grades / Announcements), not single files. While it runs, the
   button becomes **Cancel**.

You can close the popup: a small box in the corner of the Brightspace page
shows the progress. Keep that tab open until it says *Done*.

One course gives `<Course>.zip`; several courses give one zip with a folder
per course:

```
CSE12A Calculus (2026-27 Q2)/
├── Content/
│   ├── Course Information/
│   │   └── Course guide.pdf
│   └── Week 1 - Limits/
│       ├── Lecture 1.pdf
│       ├── Exercises.pdf
│       └── Links.md            only if a video in this chapter was ticked
├── Announcements.md
└── Grades.md
```

- Folders follow the Brightspace chapters, with the same nesting.
- Videos are never downloaded. YouTube topics become plain links
  (`https://www.youtube.com/watch?v=…`).
- Quizzes and external tools cannot be downloaded and are not listed.
- If a file could not be fetched, `Failed downloads.txt` lists it.

---

## Export to Obsidian

**Export to Obsidian** keeps an up-to-date copy of your courses inside an
Obsidian vault, in the layout of
[CSE-vault-sync](https://github.com/vVic1029v/CSE-vault-sync). The sync runs
in its own tab, because a popup closes as soon as it loses focus.

### First time

The first press of **Export to Obsidian** (or the gear icon in the popup)
opens the sync page:

1. **Obsidian vault**: choose the vault folder (the one that contains
   `.obsidian`). Chrome asks for permission to edit it; choose *Allow on
   every visit* so you are not asked again.
2. **Courses to keep in sync**: tick the courses.
3. **Calendar** (optional): paste your MyTimetable link, see [Calendar](#calendar).
4. Press **Sync now**.

### After that

Every press of **Export to Obsidian** opens the page and the sync starts by
itself. If something is missing, the page says what: Chrome wants access to
the folder confirmed again (one click), the vault folder was moved, or you
are logged out of Brightspace.

A running sync can be stopped with **Cancel**. Pressed while Brightspace is
still being read, nothing is written. Pressed while files are written, the
file in progress is finished, the vault stays consistent, and the next sync
adds what is missing.

### What ends up in the vault

```
<vault>/
├── ! Index.md                        root of the folder tree (VirtFolder)
├── ! Course Notes.md                 groups the course hubs
├── Brightspace/                      mirror of Brightspace: do not edit
│   ├── ! Brightspace.md              lists the courses
│   └── CSE12A - Calculus/
│       ├── CSE12A - Calculus.md      course home
│       ├── Week 1.md                 one note per chapter: contents + links
│       ├── Week 1/
│       │   ├── Lecture slides.pdf    original files next to the notes
│       │   ├── Deck.pptx + Deck.md   slide text extracted into a note
│       │   └── Intro.md              Brightspace pages become Markdown
│       ├── Assignments.md
│       ├── Grades.md
│       └── Announcements.md
├── Courses/                          your side: write your notes here
│   ├── CSE12A - Calculus.md          hub: generated block + your "## Notes"
│   └── CSE12A - Calculus Notebook.md all your class notes of this course, in one page
├── Timetable/                        one note per class (with a calendar link)
└── .brightspace-sync/                state of the extension, hidden in Obsidian
```

### Your notes are safe

- **Brightspace/** belongs to the extension. **Courses/** and the
  `## Notes` part of every timetable note belong to you.
- In generated notes that you can edit, only the block between the `AUTO`
  markers is rewritten. Everything else is kept.
- Nothing is duplicated. A sync adds what is new and updates what changed,
  in place. An unchanged course costs a handful of requests and writes
  nothing.
- Two things never happen automatically: deleting files that disappeared
  from Brightspace, and overwriting a note in `Brightspace/` that you edited.
  Both are listed after the sync with a button to confirm.
- Files that get overwritten or removed are backed up first under
  `.brightspace-sync/backups/` (last three syncs). **Undo last sync**
  restores them.
- One vault belongs to one Brightspace account. A different account is
  refused instead of mixing two people's courses.
- Video and audio files are not copied; they stay links to Brightspace.

### Recommended Obsidian plugins

| Plugin | What it is for |
|---|---|
| [Dataview](https://obsidian.md/plugins?id=dataview) (enable *DataviewJS*) | class tables in the hubs, the course Notebook |
| [Full Calendar Remastered](https://obsidian.md/plugins?id=full-calendar-remastered) | the week view of `Timetable/` |
| [VirtFolder](https://obsidian.md/plugins?id=virt-folder) | the course tree under `! Index` |
| [Obsidian Git](https://obsidian.md/plugins?id=obsidian-git) (optional) | history and backup of your own notes |

If you use Obsidian Git, keep the mirror out of the repository so the PDFs
are not stored twice:

```gitignore
Brightspace/
.brightspace-sync/
.obsidian/workspace.json
.obsidian/workspace-mobile.json
.trash/
```

---

## Calendar

Paste your personal MyTimetable subscription link on the sync page (step 3).
In MyTimetable, use the subscribe / calendar sync option, not the download
button: a downloaded `.ics` only holds the week on screen.

Every sync then:

- writes one note per class into `Timetable/`, for the last 14 and the
  next 120 days (changeable under *Advanced*);
- merges the same class given to several groups at the same time into one
  note that lists all rooms;
- links each class to its course hub, notebook and Brightspace page;
- sets up Full Calendar Remastered if it is installed: a calendar on
  `Timetable/` and one colour per course. Restart Obsidian once to see it.

**How you take notes:** open the calendar (calendar icon in the left bar, or
`Ctrl+P` → *Full Calendar: Open calendar*), click today's class, and write
under `## Notes`. The course's **Notebook** in `Courses/` collects the notes
of all its classes into one page, newest first.

Only the generated block of a class note is rewritten. A class that
disappears from the timetable is removed only if you did not write anything
in it.

---

## How it works

```
 Popup ──────────────► Content script (Brightspace tab) ──► Brightspace API
   │                      scan, fetch files, build the zip
   │
   └── Export ─────────► Sync page (extension tab) ─────────► Brightspace API
                            │        │                         MyTimetable ICS
                            │        └─ compare with manifest
                            ▼
                         Obsidian vault folder (File System Access API)
```

**Reading Brightspace.** Everything goes through Brightspace's own REST API
(Valence), using the session you are already logged in with. The whole
chapter tree of a course comes from one request (`/content/toc`). Files are
fetched per topic. Requests are spaced out and retried on rate limits, so
the extension never floods the server.

**The zip** is built in the Brightspace tab (same origin, so your session
just works) with [client-zip](https://github.com/Touffy/client-zip), then
saved like a normal download.

**The vault sync** runs in an extension page that has write access to the
folder you chose (File System Access API; the folder handle is remembered
in IndexedDB). One run goes:

1. **Read**: chapter tree, pages, announcements, assignments and grades of
   each course. Pages become Markdown; the slide text of `.pptx` decks is
   extracted. Text already read is cached by last-modified date, so an
   unchanged page is not downloaded again.
2. **Build**: work out what the vault should contain (notes, files, links)
   as a list of paths and contents.
3. **Compare**: check that list against `.brightspace-sync/manifest.json`,
   which records size, date and hash of every file the extension wrote. The
   result is a plan: add, update, remove, or "you edited this, ask first".
4. **Write**: apply the safe part of the plan, backing up anything that is
   replaced. Large files are streamed straight to disk.
5. **Calendar and hubs**: rebuild `Timetable/` from the ICS feed
   ([ical.js](https://github.com/kewisch/ical.js), Europe/Amsterdam time,
   repeating events expanded), then refresh the generated block of every hub.

---

## Privacy

- Runs entirely in your browser. There is no server, no account and no
  analytics.
- Uses your existing Brightspace login; it never sees your password.
- Only talks to `brightspace.tudelft.nl` and `mytimetable.tudelft.nl`.
- Your MyTimetable link stays in the extension's local storage. Treat it
  like a password: anyone with the link can see your timetable.

---

## Limits

- The zip is built in memory before it is saved. Fine for slides and
  documents; a course with gigabytes of uploaded video files may be too much.
- Requests are throttled (about four per second, one at a time). A large
  course takes a while on the first sync; later syncs are much faster.
- Chrome may ask again for access to the vault folder after a restart,
  unless you chose *Allow on every visit*.
- Built for TU Delft's Brightspace and MyTimetable. Other Brightspace
  instances would need a different address in `wxt.config.ts`.

---

## Development

Built with [WXT](https://wxt.dev) (Manifest V3) and TypeScript.

```bash
npm run dev         # browser with hot reload
npm test            # unit tests (vitest)
npm run typecheck
npm run build       # output in .output/chrome-mv3
npm run zip         # packed extension
```

```
public/icon/                  extension icon (16/32/48/128.png)
src/entrypoints/popup/        the popup: course tree, options, buttons
src/entrypoints/content.ts    runs in the Brightspace tab: scan, fetch, zip
src/entrypoints/sync/         Obsidian sync page
src/lib/valence.ts            throttled, read-only Brightspace API client
src/lib/scan.ts               course structure -> tree of chapters and topics
src/lib/zipexport.ts          zip layout, Links.md, Announcements.md, Grades.md
src/lib/grades.ts             Grades.md tables
src/lib/htmlmd.ts             HTML -> Markdown
src/lib/pptx.ts               slide text of .pptx decks
src/lib/vault/build.ts        notes and links in the CSE-vault-sync layout
src/lib/vault/sync.ts         manifest, compare / apply / undo, backups
src/lib/vault/hubs.ts         Courses/ hubs and notebooks (your text kept)
src/lib/vault/timetable.ts    MyTimetable feed -> Timetable/ notes, Full Calendar setup
src/lib/vault/run.ts          one sync run, start to finish
tests/                        unit tests
```

---

## Fair use

For your own courses only. Do not redistribute downloaded material: it
belongs to TU Delft and the course staff.

This project is not affiliated with TU Delft or D2L. The vault layout
follows [CSE-vault-sync](https://github.com/vVic1029v/CSE-vault-sync).
