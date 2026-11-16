import { browser } from 'wxt/browser';
import type {
  CoursesReply, DownloadRequest, Job, Reply, Request, ScanReply, TreeItem,
} from '@/lib/messages';
import { countFolders, leafIds, tickState } from '@/lib/selection';
import { BASE } from '@/lib/valence';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  return node;
}

type Flags = Pick<DownloadRequest, 'links' | 'announcements' | 'grades'>;
interface Stored {
  flags: Flags;
  /** courseId -> ticked topic ids */
  selected: Record<string, string[]>;
  /** courseId -> whether the course has anything to download, and when we looked */
  content: Record<string, { has: boolean; at: number }>;
}

interface CourseState {
  id: number;
  name: string;
  items: TreeItem[] | null; // null until read from Brightspace
  loading: boolean;
  error: string;
  selected: Set<string>;
  /** does the course have anything to download? Courses without are not listed. */
  has: boolean | null;
}

const CHEVRON =
  '<svg viewBox="0 0 12 12"><path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_FILE =
  '<svg viewBox="0 0 16 16"><path d="M4 1.5h5l3 3v10H4z M9 1.5v3h3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
const ICON_VIDEO =
  '<svg viewBox="0 0 16 16"><rect x="1.5" y="3" width="13" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6.5 5.8v4.4L10.5 8z" fill="currentColor"/></svg>';

let tabId = -1;
let flags: Flags = { links: false, announcements: false, grades: false };
let stored: Record<string, string[]> = {};
let content: Stored['content'] = {};
/** An empty course is looked at again after a day, in case material was added. */
const EMPTY_TTL = 24 * 60 * 60 * 1000;
let courses: CourseState[] = [];
let currentId: number | null = null;
/** expanded rows: `c<courseId>` and `f<courseId>:<folderId>` */
const open = new Set<string>();
let running = false;

// ---------------------------------------------------------------- messaging

async function send<T>(msg: Request): Promise<T> {
  let reply: Reply<T>;
  try {
    reply = await browser.tabs.sendMessage(tabId, msg);
  } catch {
    // Tab was open before the extension was installed: inject, then retry.
    await browser.scripting.executeScript({ target: { tabId }, files: ['/content-scripts/content.js'] });
    reply = await browser.tabs.sendMessage(tabId, msg);
  }
  if (!reply) throw new Error('No answer from the BrightSpace tab — reload it and try again.');
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}

function empty(text: string, bad = false): void {
  $<HTMLButtonElement>('collapse').disabled = true;
  $<HTMLButtonElement>('select-all').disabled = true;
  $('select-all').classList.remove('active');
  $('folders').replaceChildren(el('div', { className: `empty${bad ? ' bad' : ''}`, textContent: text }));
}

function status(text: string, cls = ''): void {
  $('status').textContent = text;
  $('footer').hidden = !text && !running;
  $('status').className = cls;
}

async function save(): Promise<void> {
  for (const c of courses) if (c.items) stored[c.id] = [...c.selected];
  await browser.storage.local.set({ popup: { flags, selected: stored, content } satisfies Stored });
}

// ---------------------------------------------------------------- selection

/** Courses that take part in the download: anything ticked inside them. */
function involved(): CourseState[] {
  const withItems = courses.filter((c) => c.items && tickState(c.items, c.selected, flags.links).on > 0);
  if (withItems.length || !(flags.grades || flags.announcements)) return withItems;
  // Only Grades/Announcements ticked: they belong to the course of this page.
  return courses.filter((c) => c.id === currentId);
}

/** X: folders with something ticked, plus Grades/Announcements per course. */
function itemCount(): number {
  const extras = Number(flags.grades) + Number(flags.announcements);
  let n = 0;
  for (const c of involved()) n += (c.items ? countFolders(c.items, c.selected, flags.links) : 0) + extras;
  return n;
}

function refreshButton(): void {
  const n = itemCount();
  const btn = $<HTMLButtonElement>('download');
  btn.disabled = !running && n === 0;
  btn.classList.toggle('cancel', running);
  btn.textContent = running ? 'Cancel'
    : n === 0 ? 'Select folders to download'
    : `Download ${n} item${n === 1 ? '' : 's'}`;
}

async function loadCourse(c: CourseState): Promise<void> {
  if (c.items || c.loading) return;
  c.loading = true;
  c.error = '';
  render();
  try {
    const scan = await send<ScanReply>({ type: 'scan', courseId: c.id });
    c.items = scan.items;
    c.selected = new Set(stored[c.id] ?? []);
    c.has = leafIds(scan.items, true).length > 0;
    content[c.id] = { has: c.has, at: Date.now() };
    void save();
  } catch (ex) {
    c.error = (ex as Error).message;
    if (c.has === null) c.has = true; // keep it listed so the error is visible
  }
  c.loading = false;
  render();
}

function setTicks(c: CourseState, items: TreeItem[], on: boolean): void {
  for (const id of leafIds(items, flags.links)) on ? c.selected.add(id) : c.selected.delete(id);
  render();
  void save();
}

/** Everything there is: all three options and every item of every listed course. */
function allSelected(): boolean {
  const listed = courses.filter((c) => c.has === true);
  if (!listed.length || !(flags.grades && flags.announcements && flags.links)) return false;
  return listed.every((c) => {
    if (!c.items) return false;
    const s = tickState(c.items, c.selected, true);
    return s.on === s.total;
  });
}

let selectingAll = false;
/** "Select all" ticks everything; pressed again when all is ticked, it clears everything. */
async function toggleAll(): Promise<void> {
  if (selectingAll) return;
  const on = !allSelected();
  flags = { grades: on, announcements: on, links: on };
  for (const box of document.querySelectorAll<HTMLInputElement>('[data-opt]')) box.checked = on;
  if (!on) stored = {}; // also forget ticks remembered for courses not opened yet
  selectingAll = true;
  render();
  try {
    for (const c of courses) {
      if (c.has !== true) continue;
      // Courses not opened yet have to be read before their items can be ticked.
      if (on && !c.items) await loadCourse(c);
      if (!c.items) continue;
      c.selected = new Set(on ? leafIds(c.items, true) : []);
      render();
    }
  } finally {
    selectingAll = false;
    render();
    void save();
  }
}

// ---------------------------------------------------------------- tree

function row(opts: {
  title: string; depth: number; key?: string; count?: number; tag?: string; icon?: string;
  state: { on: number; total: number }; disabled?: boolean;
  onToggle: (on: boolean) => void; onOpen?: (isOpen: boolean) => void;
}): HTMLElement {
  const line = el('div', { className: 'row' });
  line.style.paddingLeft = `${opts.depth * 18}px`;
  const isOpen = !!opts.key && open.has(opts.key);
  const twist = el('button', { className: `twist${isOpen ? ' open' : ''}`, innerHTML: CHEVRON, disabled: !opts.key });
  twist.setAttribute('aria-label', isOpen ? 'Collapse' : 'Expand');
  if (opts.key) {
    const key = opts.key;
    twist.addEventListener('click', () => {
      open.has(key) ? open.delete(key) : open.add(key);
      opts.onOpen?.(open.has(key));
      render();
    });
  }
  const box = el('input', { type: 'checkbox', disabled: !!opts.disabled });
  box.checked = opts.state.total > 0 && opts.state.on === opts.state.total;
  box.indeterminate = opts.state.on > 0 && opts.state.on < opts.state.total;
  box.addEventListener('change', () => opts.onToggle(box.checked));
  line.classList.toggle('on', opts.state.on > 0);
  const lab = el('label');
  lab.append(box);
  if (opts.icon) lab.append(el('span', { className: 'icon', innerHTML: opts.icon }));
  lab.append(el('span', { className: 'title', textContent: opts.title, title: opts.title }));
  if (opts.count) lab.append(el('span', { className: 'count', textContent: String(opts.count) }));
  if (opts.tag) lab.append(el('span', { className: 'tag', textContent: opts.tag }));
  line.append(twist, lab);
  return line;
}

function renderItems(c: CourseState, items: TreeItem[], depth: number, into: HTMLElement): void {
  for (const it of items) {
    if (it.kind === 'folder') {
      const kids = it.children || [];
      const state = tickState(kids, c.selected, flags.links);
      const key = `f${c.id}:${it.id}`;
      into.append(row({
        title: it.title, depth, key: state.total ? key : undefined, count: state.total, state,
        disabled: state.total === 0,
        onToggle: (on) => setTicks(c, kids, on),
      }));
      if (state.total && open.has(key)) renderItems(c, kids, depth + 1, into);
      continue;
    }
    if (it.kind === 'video' && !flags.links) continue;
    into.append(row({
      title: it.title, depth, tag: it.kind === 'video' ? 'video' : it.tag,
      icon: it.kind === 'video' ? ICON_VIDEO : ICON_FILE,
      state: { on: Number(c.selected.has(it.id)), total: 1 },
      onToggle: (on) => {
        on ? c.selected.add(it.id) : c.selected.delete(it.id);
        render();
        void save();
      },
    }));
  }
}

function render(): void {
  const root = $('folders');
  if (!courses.length) return;
  const scroll = root.scrollTop;
  const frag = document.createDocumentFragment() as unknown as HTMLElement;
  // Only courses that have something to download are listed. Brightspace also
  // enrols students in programme/community pages with no content.
  const listed = courses.filter((c) => c.has === true);
  const pending = courses.filter((c) => c.has === null).length;
  $<HTMLButtonElement>('collapse').disabled = open.size === 0;
  $<HTMLButtonElement>('select-all').disabled = selectingAll || !listed.length;
  $('select-all').classList.toggle('active', allSelected());
  if (!listed.length) {
    empty(pending ? 'Reading your courses…' : 'No courses with content.');
    refreshButton();
    return;
  }
  for (const c of listed) {
    const key = `c${c.id}`;
    const state = c.items ? tickState(c.items, c.selected, flags.links) : { on: 0, total: 1 };
    frag.append(row({
      title: c.name, depth: 0, key, state,
      count: c.items ? state.total : undefined,
      disabled: c.loading || (!!c.items && state.total === 0),
      onOpen: (isOpen) => {
        if (isOpen) void loadCourse(c);
      },
      // Ticking a course that was not read yet reads it first, then ticks everything.
      onToggle: async (on) => {
        if (!c.items) {
          open.add(key);
          await loadCourse(c);
        }
        if (c.items) setTicks(c, c.items, on);
      },
    }));
    if (!open.has(key)) continue;
    if (c.loading) frag.append(el('div', { className: 'note', textContent: 'Reading course content…' }));
    else if (c.error) frag.append(el('div', { className: 'note bad', textContent: c.error }));
    else if (c.items && !c.items.length) frag.append(el('div', { className: 'note', textContent: 'No content.' }));
    else if (c.items) renderItems(c, c.items, 1, frag);
  }
  if (pending) frag.append(el('div', { className: 'note', textContent: `Checking ${pending} more course${pending === 1 ? '' : 's'}…` }));
  root.replaceChildren(frag);
  root.scrollTop = scroll;
  refreshButton();
}

// ---------------------------------------------------------------- download

function showJob(job: Job): void {
  running = job.state === 'running';
  const bar = $<HTMLProgressElement>('progress');
  bar.hidden = !running;
  $('footer').hidden = !running && !$('status').textContent;
  if (running) {
    if (job.total) {
      bar.max = job.total;
      bar.value = job.done;
    } else bar.removeAttribute('value');
  }
  if (job.state !== 'idle') status(job.message, job.state === 'error' ? 'bad' : job.state === 'done' ? 'ok' : '');
  refreshButton();
}

async function startDownload(): Promise<void> {
  try {
    await save();
    const request: DownloadRequest = {
      ...flags,
      courses: involved().map((c) => ({ courseId: c.id, selected: [...c.selected] })),
    };
    const job = await send<Job>({ type: 'download', request });
    showJob({ ...job, state: 'running' });
    status('Downloading… keep the BrightSpace tab open (this popup can be closed).');
  } catch (ex) {
    status((ex as Error).message, 'bad');
  }
}

// ---------------------------------------------------------------- Obsidian

/**
 * The sync itself runs in its own tab: a popup closes the moment it loses
 * focus, and writing into the vault folder needs a page that stays open.
 * If that tab is already open it is reused.
 */
async function openSync(run: boolean): Promise<void> {
  const base = browser.runtime.getURL('/sync.html');
  try {
    const tabs = await browser.runtime.getContexts({ contextTypes: ['TAB'] });
    const open = tabs.find((c) => c.documentUrl?.startsWith(base));
    if (open && open.tabId >= 0) {
      // Message first: focusing the tab closes this popup.
      if (run) await browser.runtime.sendMessage({ type: 'vault-run' }).catch(() => {});
      if (open.windowId >= 0) await browser.windows.update(open.windowId, { focused: true });
      await browser.tabs.update(open.tabId, { active: true });
      window.close();
      return;
    }
  } catch {
    /* fall through to a new tab */
  }
  await browser.tabs.create({ url: `${base}${run ? '#run' : ''}` });
}

// ---------------------------------------------------------------- init

async function init(): Promise<void> {
  // Export starts a sync on the sync page; the gear only opens that page.
  $('obsidian').addEventListener('click', () => void openSync(true));
  $('settings').addEventListener('click', () => void openSync(false));

  const saved = (await browser.storage.local.get('popup')).popup as Partial<Stored> | undefined;
  if (saved?.flags) flags = { ...flags, ...saved.flags };
  if (saved?.selected) stored = saved.selected;
  if (saved?.content) content = saved.content;
  $('select-all').addEventListener('click', () => void toggleAll());
  $('collapse').addEventListener('click', () => {
    open.clear();
    render();
  });

  for (const box of document.querySelectorAll<HTMLInputElement>('[data-opt]')) {
    const key = box.dataset.opt as keyof Flags;
    box.checked = flags[key];
    box.addEventListener('change', () => {
      flags[key] = box.checked;
      render();
      refreshButton();
      void save();
    });
  }
  $('download').addEventListener('click', () => {
    if (running) void send<Job>({ type: 'cancel' }).then(showJob, () => {});
    else void startDownload();
  });
  browser.runtime.onMessage.addListener((msg: { type?: string; job?: Job }) => {
    if (msg?.type === 'progress' && msg.job) showJob(msg.job);
  });
  refreshButton();

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith(BASE)) return; // keeps the "open BrightSpace" hint
  tabId = tab.id;

  empty('Reading your courses…');
  let info: CoursesReply;
  try {
    info = await send<CoursesReply>({ type: 'courses' });
  } catch (ex) {
    empty('Reload the BrightSpace page, then open this again.', true);
    status((ex as Error).message, 'bad');
    return;
  }
  if (!info.loggedIn) {
    empty('Log in to BrightSpace first.');
    return;
  }
  currentId = info.currentId;
  const shown = info.courses.filter((c) => c.active || c.id === currentId);
  // The course of the open page comes first.
  shown.sort((a, b) => Number(b.id === currentId) - Number(a.id === currentId));
  if (!shown.length) {
    empty('No courses found.');
    return;
  }
  courses = shown.map((c) => {
    const seen = content[c.id];
    const fresh = seen && (seen.has || Date.now() - seen.at < EMPTY_TTL);
    return {
      id: c.id, name: c.name, items: null, loading: false, error: '', selected: new Set<string>(),
      has: fresh ? seen.has : null,
    };
  });
  const here = courses.find((c) => c.id === currentId);
  if (here && here.has !== false) open.add(`c${here.id}`);
  render();
  // Read the open course, then look at courses we know nothing about yet.
  void (async () => {
    if (here && here.has !== false) await loadCourse(here);
    for (const c of courses) if (c.has === null) await loadCourse(c);
  })();
  const job = await send<Job>({ type: 'status' }).catch(() => null);
  if (job) showJob(job);
}

void init();
