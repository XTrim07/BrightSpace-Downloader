import { browser } from 'wxt/browser';
import type { Category, Course, ScannedCourse, Selection, TreeNode } from '@/lib/model';
import { categoryOf, filterTree, nodeKey, walkTree } from '@/lib/model';
import { hydrate, scanCourse, type ScanState } from '@/lib/scan';
import { humanSize } from '@/lib/util';
import { AuthExpiredError, BASE, enrollments, ValenceClient, whoami } from '@/lib/valence';
import { addVaultHome, buildVault, type BuildOptions } from '@/lib/vault/build';
import { HandleFS } from '@/lib/vault/fs';
import {
  applyPlan, groupOf, lastSync, loadManifest, planSync, undoLast,
  type Action, type Group, type Manifest, type Plan,
} from '@/lib/vault/sync';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, props: Record<string, any> = {}, ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else (el as any)[k] = v;
  }
  el.append(...children);
  return el;
}

// ---------------------------------------------------------------- state

interface Settings {
  courseIds: number[];
  categories: Record<Category, boolean>;
  announcements: boolean;
  assignments: boolean;
  grades: boolean;
  maxFileMB: number;
  excluded: string[];
  hideInactive: boolean;
  outName: string;
  virtFolder: boolean;
  virtRoot: string;
}

const DEFAULTS: Settings = {
  courseIds: [],
  categories: { documents: true, videos: false, pages: true, links: true, other: true },
  announcements: true,
  assignments: true,
  grades: true,
  maxFileMB: 0,
  excluded: [],
  hideInactive: true,
  outName: 'Brightspace',
  virtFolder: true,
  virtRoot: '! Index',
};

const MAX_BACKUP_BYTES = 200 * 1024 * 1024;

const api = new ValenceClient();
let settings: Settings = structuredClone(DEFAULTS);
let scanState: ScanState = { names: {}, descs: {} };
let courses: Course[] = [];
const scanned = new Map<number, ScannedCourse>();
const excluded = new Set<string>();
let vault: FileSystemDirectoryHandle | null = null;
let manifest: Manifest | null = null;
let plan: Plan | null = null;
let busy = false;

function selection(): Selection {
  return {
    categories: settings.categories,
    announcements: settings.announcements,
    assignments: settings.assignments,
    grades: settings.grades,
    excluded,
    maxFileMB: settings.maxFileMB,
  };
}

function buildOptions(): BuildOptions {
  return {
    outName: settings.outName.trim() || 'Brightspace',
    virtFolder: settings.virtFolder,
    virtRoot: settings.virtRoot.trim(),
  };
}

const selectedScans = () =>
  courses.filter((c) => settings.courseIds.includes(c.id) && scanned.has(c.id)).map((c) => scanned.get(c.id)!);

async function saveSettings(): Promise<void> {
  settings.excluded = [...excluded];
  await browser.storage.local.set({ settings });
}

// ---------------------------------------------------------------- persistence of the folder handle

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('bvs', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('kv').objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------- feedback

function log(msg: string): void {
  const el = $('log');
  el.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

function status(msg: string, done?: number, total?: number): void {
  $('status').textContent = msg;
  const bar = $<HTMLProgressElement>('progress');
  bar.hidden = done === undefined;
  if (done !== undefined) {
    if (total) {
      bar.max = total;
      bar.value = done;
    } else bar.removeAttribute('value');
  }
}

function refreshButtons(): void {
  const haveScan = selectedScans().length > 0;
  $<HTMLButtonElement>('scan').disabled = busy || !settings.courseIds.length;
  $<HTMLButtonElement>('connect').disabled = busy;
  $<HTMLButtonElement>('preview').disabled = busy || !haveScan || !vault;
  $<HTMLButtonElement>('undo').disabled = busy || !vault;
  const apply = document.getElementById('apply') as HTMLButtonElement | null;
  if (apply) apply.disabled = busy;
}

/** Run one long task with the UI locked; errors land in the log. */
async function task(name: string, fn: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  refreshButtons();
  try {
    await fn();
  } catch (ex) {
    if ((ex as DOMException)?.name === 'AbortError') {
      status('Cancelled.');
    } else if (ex instanceof AuthExpiredError) {
      status('Your Brightspace session expired — log in again and retry.');
      log(`${name}: ${ex.message}`);
      showSession(null);
    } else {
      status(`${name} failed: ${(ex as Error).message || ex}`);
      log(`${name} failed: ${(ex as Error).stack || ex}`);
    }
  } finally {
    busy = false;
    refreshButtons();
  }
}

window.addEventListener('beforeunload', (e) => {
  if (busy) e.preventDefault();
});

// ---------------------------------------------------------------- session + courses

function showSession(me: { name: string; uniqueName: string } | null): void {
  const el = $('session');
  el.replaceChildren();
  if (me) {
    el.className = 'pill ok';
    el.textContent = `Logged in as ${me.name || me.uniqueName}`;
  } else {
    el.className = 'pill bad';
    el.append(
      'Not logged in — ',
      h('a', { href: BASE, target: '_blank', rel: 'noreferrer' }, 'open Brightspace'),
      ', log in, then ',
      h('button', { class: 'link', onclick: () => void loadSession() }, 'retry'),
    );
  }
}

async function loadSession(): Promise<void> {
  $('session').className = 'pill';
  $('session').textContent = 'Checking session…';
  try {
    const me = await whoami(api);
    showSession(me);
    if (!me) return;
    courses = await enrollments(api);
    renderCourses();
  } catch (ex) {
    showSession(null);
    if (!(ex instanceof AuthExpiredError)) log(`Could not reach Brightspace: ${(ex as Error).message}`);
  }
}

function courseEnded(c: Course): boolean {
  return c.active === false || (!!c.end && new Date(c.end).getTime() < Date.now());
}

function renderCourses(): void {
  const list = $('course-list');
  const filter = $<HTMLInputElement>('course-filter').value.trim().toLowerCase();
  list.replaceChildren();
  const picked = new Set(settings.courseIds);
  for (const c of courses) {
    const ended = courseEnded(c);
    if (settings.hideInactive && ended && !picked.has(c.id)) continue;
    if (filter && !`${c.name} ${c.code}`.toLowerCase().includes(filter)) continue;
    const box = h('input', {
      type: 'checkbox',
      checked: picked.has(c.id),
      onchange: () => {
        if (box.checked) settings.courseIds = [...new Set([...settings.courseIds, c.id])];
        else settings.courseIds = settings.courseIds.filter((id) => id !== c.id);
        void saveSettings();
        renderTree();
        refreshButtons();
      },
    });
    box.dataset.id = String(c.id);
    list.append(
      h('label', { class: ended ? 'inactive' : '' }, box, h('span', {}, c.name),
        h('span', { class: 'code' }, `${c.code}${scanned.has(c.id) ? ' · scanned' : ''}`)),
    );
  }
  if (!list.children.length) {
    list.append(h('div', { class: 'hint' }, courses.length ? 'No courses match.' : 'No courses found.'));
  }
  refreshButtons();
}

function setShownCourses(on: boolean): void {
  const shown = [...$('course-list').querySelectorAll<HTMLInputElement>('input[type=checkbox]')]
    .map((b) => Number(b.dataset.id));
  const set = new Set(settings.courseIds);
  for (const id of shown) on ? set.add(id) : set.delete(id);
  settings.courseIds = [...set];
  void saveSettings();
  renderCourses();
  renderTree();
}

async function runScan(): Promise<void> {
  const todo = courses.filter((c) => settings.courseIds.includes(c.id));
  let i = 0;
  for (const c of todo) {
    i++;
    status(`Scanning ${c.name}…`, i - 1, todo.length);
    const sc = await scanCourse(api, c, scanState, (msg) =>
      status(`Scanning ${c.name} — ${msg}`, i - 1, todo.length));
    scanned.set(c.id, sc);
    for (const e of sc.errors) log(`${sc.code}: ${e}`);
    let n = 0;
    for (const node of walkTree(sc.tree)) if (node.kind !== 'module') n++;
    log(`Scanned ${sc.code}: ${n} items`);
    await browser.storage.local.set({ scanState });
    renderTree();
  }
  plan = null;
  renderPlan();
  renderCourses();
  status(`Scanned ${todo.length} course${todo.length === 1 ? '' : 's'} (${api.requests} requests so far).`);
}

// ---------------------------------------------------------------- content tree

const boxes = new Map<string, HTMLInputElement>();

function renderTree(): void {
  const root = $('tree');
  root.replaceChildren();
  boxes.clear();
  const sel = selection();
  for (const sc of selectedScans()) {
    const body = renderNodes(sc, sc.tree, sel);
    const extras = [
      sc.announcements ? 'announcements' : '', sc.dropbox ? `${sc.dropbox.length} assignments` : '',
      sc.grades ? 'grades' : '',
    ].filter(Boolean).join(', ');
    root.append(
      h('details', { open: selectedScans().length === 1 },
        h('summary', {}, h('strong', {}, sc.course.name),
          h('span', { class: 'count' }, extras ? `also: ${extras}` : '')),
        ...body),
    );
  }
  syncBoxes();
}

function renderNodes(sc: ScannedCourse, nodes: TreeNode[], sel: Selection): HTMLElement[] {
  const cid = sc.course.id;
  return nodes.map((node) => {
    const key = nodeKey(cid, node);
    if (node.kind === 'locked') {
      return h('div', { class: 'leaf locked', title: node.reason || '' }, `🔒 ${node.title}`);
    }
    const box = h('input', { type: 'checkbox' });
    boxes.set(key, box);
    if (node.kind === 'module') {
      box.addEventListener('change', () => {
        setSubtree(cid, node, !box.checked);
        afterTreeChange();
      });
      box.addEventListener('click', (e) => e.stopPropagation());
      let leaves = 0;
      for (const n of walkTree(node.children || [])) if (n.kind !== 'module' && n.kind !== 'locked') leaves++;
      return h('details', {},
        h('summary', {}, box, ` ${node.title}`, h('span', { class: 'count' }, String(leaves))),
        ...renderNodes(sc, node.children || [], sel));
    }
    box.addEventListener('change', () => {
      box.checked ? excluded.delete(key) : excluded.add(key);
      afterTreeChange();
    });
    const cat = categoryOf(node)!;
    const ext = node.kind === 'file' ? (node.name || '').split('.').pop() : node.kind;
    return h('label', { class: `leaf${sel.categories[cat] ? '' : ' off'}`, title: node.path || node.url || '' },
      box, h('span', {}, node.title), h('span', { class: 'tag' }, ext || cat));
  });
}

function setSubtree(cid: number, node: TreeNode, off: boolean): void {
  for (const n of [node, ...walkTree(node.children || [])]) {
    if (n.kind === 'locked') continue;
    const key = nodeKey(cid, n);
    off ? excluded.add(key) : excluded.delete(key);
  }
}

/** Derive module checkbox states (checked / indeterminate / unchecked) from their leaves. */
function syncBoxes(): void {
  const visit = (cid: number, nodes: TreeNode[]): [number, number] => {
    let total = 0;
    let off = 0;
    for (const node of nodes) {
      if (node.kind === 'locked') continue;
      const key = nodeKey(cid, node);
      const box = boxes.get(key);
      if (node.kind === 'module') {
        const [t, o] = visit(cid, node.children || []);
        if (t > 0) {
          // A module whose every item is unticked is dropped as a whole.
          o === t ? excluded.add(key) : excluded.delete(key);
        }
        if (box) {
          box.checked = !excluded.has(key);
          box.indeterminate = t > 0 && o > 0 && o < t;
        }
        total += t;
        off += o;
      } else {
        total++;
        if (excluded.has(key)) off++;
        if (box) box.checked = !excluded.has(key);
      }
    }
    return [total, off];
  };
  for (const sc of selectedScans()) visit(sc.course.id, sc.tree);
  renderSummary();
}

function afterTreeChange(): void {
  syncBoxes();
  plan = null;
  renderPlan();
  void saveSettings();
}

function renderSummary(): void {
  const scans = selectedScans();
  if (!scans.length) {
    $('summary').textContent = 'Scan courses to pick individual modules and files.';
    return;
  }
  const counts: Record<Category, number> = { documents: 0, videos: 0, pages: 0, links: 0, other: 0 };
  const sel = selection();
  for (const sc of scans) {
    for (const node of walkTree(filterTree(sc.course.id, sc.tree, sel))) {
      const cat = categoryOf(node);
      if (cat) counts[cat]++;
    }
  }
  const parts = (Object.keys(counts) as Category[]).filter((c) => counts[c]).map((c) => `${counts[c]} ${c}`);
  $('summary').textContent = `Selected in ${scans.length} course${scans.length === 1 ? '' : 's'}: ${
    parts.join(', ') || 'nothing'}. Untick modules or files below to leave them out.`;
}

// ---------------------------------------------------------------- vault

async function ensureVaultAccess(): Promise<HandleFS> {
  if (!vault) throw new Error('Connect a vault folder first.');
  const h2 = vault as any;
  if ((await h2.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    if ((await h2.requestPermission({ mode: 'readwrite' })) !== 'granted') {
      throw new Error('Write access to the vault folder was not granted.');
    }
  }
  return new HandleFS(vault);
}

async function describeVault(): Promise<void> {
  const el = $('vault-status');
  if (!vault) {
    el.textContent = 'No vault connected.';
    return;
  }
  const h2 = vault as any;
  if ((await h2.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    el.textContent = `“${vault.name}” — access is re-confirmed on the next preview.`;
    return;
  }
  const fs = new HandleFS(vault);
  const dirs = await fs.listDirs('');
  const isVault = dirs.includes('.obsidian');
  const out = buildOptions().outName;
  const last = await lastSync(fs);
  el.replaceChildren(
    h('span', { class: isVault ? 'ok' : 'warn' },
      `“${vault.name}” ${isVault ? '✓ Obsidian vault' : '— no .obsidian folder here, is this the vault root?'}`),
    ` · ${dirs.includes(out) ? `${out}/ exists` : `${out}/ will be created`}`,
    last ? ` · last sync ${last.ts}` : '',
  );
}

async function connectVault(): Promise<void> {
  vault = await (window as any).showDirectoryPicker({ id: 'vault', mode: 'readwrite' });
  await idbSet('vault', vault);
  plan = null;
  renderPlan();
  await describeVault();
}

async function runPreview(): Promise<void> {
  const fs = await ensureVaultAccess();
  const scans = selectedScans();
  const sel = selection();
  let i = 0;
  for (const sc of scans) {
    status(`Reading pages of ${sc.course.name}…`, i++, scans.length);
    const errors = await hydrate(api, sc.course.id, filterTree(sc.course.id, sc.tree, sel), (t) =>
      status(`Reading pages of ${sc.course.name} — ${t}`, i - 1, scans.length));
    for (const e of errors) log(`${sc.code}: could not read ${e}`);
  }
  status('Comparing with the vault…');
  const opts = buildOptions();
  manifest = await loadManifest(fs);
  const build = buildVault(scans, sel, opts);
  const codes = scans.map((s) => s.code);
  build.homes = addVaultHome(build, manifest.courses, codes, opts, new Date().toISOString().slice(0, 10));
  plan = await planSync(fs, opts.outName, build, manifest, codes);
  renderPlan();
  status(plan.actions.length
    ? `Preview ready: ${plan.actions.length} change${plan.actions.length === 1 ? '' : 's'}, ${plan.unchanged} unchanged. Nothing has been written yet.`
    : `Vault is up to date (${plan.unchanged} files unchanged).`);
  await describeVault();
}

const GROUPS: { id: Group; title: string; on: boolean; danger: boolean; note: string }[] = [
  { id: 'add', title: 'Add new files', on: true, danger: false, note: '' },
  { id: 'modify', title: 'Update changed files', on: true, danger: false, note: 'Old versions are backed up.' },
  { id: 'overwriteEdited', title: 'Overwrite files you edited by hand', on: false, danger: true,
    note: 'These changed on disk since the last sync. Old versions are backed up.' },
  { id: 'remove', title: 'Remove files no longer on Brightspace (or unticked)', on: false, danger: true,
    note: 'Only files this extension wrote. Backed up before removal.' },
  { id: 'removeEdited', title: 'Remove files you edited by hand', on: false, danger: true,
    note: 'Backed up before removal.' },
];

function diffBlock(diff: string): HTMLElement {
  const pre = h('pre', { class: 'diff' });
  for (const line of diff.split('\n')) {
    const cls = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : '';
    pre.append(h('span', { class: cls }, line + '\n'));
  }
  return pre;
}

function renderPlan(): void {
  const root = $('plan');
  root.replaceChildren();
  root.hidden = !plan;
  if (!plan) return;
  const current = plan;
  const out = buildOptions().outName;
  root.append(h('h3', {}, `Preview — ${out}/`));
  const toggles = new Map<Group, HTMLInputElement>();
  for (const g of GROUPS) {
    const items = current.actions.filter((a) => groupOf(a) === g.id);
    if (!items.length) continue;
    const box = h('input', { type: 'checkbox', checked: g.on });
    toggles.set(g.id, box);
    const big = items.filter((a: Action) => a.op !== 'add' && a.size > MAX_BACKUP_BYTES);
    const list = h('ul', {});
    for (const a of items) {
      const li = h('li', {}, a.path, a.op !== 'add' && a.kind === 'bin' ? ` (${humanSize(a.size)})` : '');
      if (a.diff) li.append(h('details', {}, h('summary', {}, 'diff'), diffBlock(a.diff)));
      list.append(li);
    }
    root.append(
      h('div', { class: `group${g.danger ? ' danger' : ''}` },
        h('label', {}, box, ` ${g.title} (${items.length})`),
        g.note ? h('div', { class: 'hint' }, g.note) : '',
        big.length
          ? h('div', { class: 'warn' }, `${big.length} file(s) over ${humanSize(MAX_BACKUP_BYTES)} are too large to back up and will be left untouched.`)
          : '',
        h('details', { open: items.length <= 12 }, h('summary', {}, 'files'), list)),
    );
  }
  if (current.untracked.length) {
    const list = h('ul', {}, ...current.untracked.map((p) => h('li', {}, p)));
    root.append(h('div', { class: 'group' },
      h('strong', {}, `Left alone: ${current.untracked.length} file(s) not created by this extension`),
      h('details', {}, h('summary', {}, 'files'), list)));
  }
  const apply = h('button', {
    class: 'primary', id: 'apply',
    onclick: () => void task('Apply', async () => {
      const groups = Object.fromEntries(GROUPS.map((g) => [g.id, toggles.get(g.id)?.checked ?? false])) as Record<Group, boolean>;
      await runApply(current, groups);
    }),
  }, current.actions.length ? 'Apply selected changes' : 'Record current state');
  root.append(h('div', { class: 'row' }, apply,
    h('span', { class: 'hint' }, `${current.unchanged} files already up to date.`)));
}

async function runApply(current: Plan, groups: Record<Group, boolean>): Promise<void> {
  const fs = await ensureVaultAccess();
  const opts = buildOptions();
  manifest = await loadManifest(fs);
  const result = await applyPlan(fs, opts.outName, current, manifest, groups,
    (cid, tid) => api.fetchFile(cid, tid),
    {
      maxBackupBytes: MAX_BACKUP_BYTES,
      allowNoBackup: false,
      maxFileBytes: settings.maxFileMB > 0 ? settings.maxFileMB * 1024 * 1024 : 0,
    },
    (done, total, path) => status(`Writing ${done}/${total} · ${path}`, done, total));
  for (const f of result.failed) log(`failed: ${f.path} (${f.reason})`);
  for (const s of result.skipped) log(`skipped: ${s.path} (${s.reason})`);
  log(`Sync ${result.ts}: +${result.added.length} added, ~${result.modified.length} updated, -${result.removed.length} removed`);
  plan = null;
  renderPlan();
  status(`Vault synced: ${result.added.length} added, ${result.modified.length} updated, ${result.removed.length} removed` +
    `${result.failed.length ? `, ${result.failed.length} failed (see log)` : ''}` +
    `${result.skipped.length ? `, ${result.skipped.length} skipped` : ''}.`);
  await describeVault();
}

async function runUndo(): Promise<void> {
  const fs = await ensureVaultAccess();
  const last = await lastSync(fs);
  if (!last) {
    status('Nothing to undo.');
    return;
  }
  const n = last.added.length + last.modified.length + last.removed.length;
  if (!confirm(`Undo the sync from ${last.ts}?\n\n${last.added.length} added files will be deleted, ` +
    `${last.backedUp.length} changed/removed files restored (${n} changes in total).`)) return;
  const res = await undoLast(fs);
  if (!res) return;
  for (const p of res.lost) log(`not restorable (no backup): ${p}`);
  plan = null;
  renderPlan();
  status(`Undid sync ${res.ts}: ${res.deleted} deleted, ${res.restored} restored` +
    `${res.lost.length ? `, ${res.lost.length} could not be restored` : ''}.`);
  await describeVault();
}

// ---------------------------------------------------------------- wiring

function bindSettings(): void {
  for (const box of document.querySelectorAll<HTMLInputElement>('[data-cat]')) {
    const cat = box.dataset.cat as Category;
    box.checked = settings.categories[cat];
    box.addEventListener('change', () => {
      settings.categories[cat] = box.checked;
      renderTree();
      afterTreeChange();
    });
  }
  for (const box of document.querySelectorAll<HTMLInputElement>('[data-flag]')) {
    const flag = box.dataset.flag as 'announcements' | 'assignments' | 'grades';
    box.checked = settings[flag];
    box.addEventListener('change', () => {
      settings[flag] = box.checked;
      afterTreeChange();
    });
  }
  const bind = <K extends keyof Settings>(id: string, key: K, read: (el: HTMLInputElement) => Settings[K]) => {
    const el = $<HTMLInputElement>(id);
    if (el.type === 'checkbox') el.checked = settings[key] as boolean;
    else el.value = String(settings[key]);
    el.addEventListener('change', () => {
      settings[key] = read(el);
      plan = null;
      renderPlan();
      void saveSettings();
      if (key === 'hideInactive') renderCourses();
      if (key === 'outName') void describeVault();
    });
  };
  bind('max-mb', 'maxFileMB', (el) => Math.max(0, Number(el.value) || 0));
  bind('hide-inactive', 'hideInactive', (el) => el.checked);
  bind('out-name', 'outName', (el) => el.value.replace(/[\\/:*?"<>|]/g, '').trim() || 'Brightspace');
  bind('virt-folder', 'virtFolder', (el) => el.checked);
  bind('virt-root', 'virtRoot', (el) => el.value);

  $('course-filter').addEventListener('input', renderCourses);
  $('courses-all').addEventListener('click', () => setShownCourses(true));
  $('courses-none').addEventListener('click', () => setShownCourses(false));
  $('scan').addEventListener('click', () => void task('Scan', runScan));
  $('connect').addEventListener('click', () => void task('Connect vault', connectVault));
  $('preview').addEventListener('click', () => void task('Preview', runPreview));
  $('undo').addEventListener('click', () => void task('Undo', runUndo));
}

async function init(): Promise<void> {
  const stored = await browser.storage.local.get(['settings', 'scanState']);
  if (stored.settings) {
    const s = stored.settings as Partial<Settings>;
    settings = { ...DEFAULTS, ...s, categories: { ...DEFAULTS.categories, ...s.categories } };
  }
  if (stored.scanState) scanState = { names: {}, descs: {}, ...(stored.scanState as Partial<ScanState>) };
  for (const key of settings.excluded) excluded.add(key);
  bindSettings();
  refreshButtons();
  try {
    vault = (await idbGet<FileSystemDirectoryHandle>('vault')) ?? null;
    await describeVault();
  } catch {
    vault = null;
  }
  refreshButtons();
  await loadSession();
}

void init();
