/**
 * Obsidian sync page. Set up once (vault folder + courses); after that the
 * popup's "Export to Obsidian" opens this page with #run and the sync starts
 * by itself. The page also explains what is missing when it cannot start:
 * vault access lost, vault moved, not logged in.
 *
 * The work runs here, not in the popup: a popup closes as soon as it loses
 * focus, and writing into a folder needs the File System Access API.
 */

import { browser } from 'wxt/browser';
import type { Course } from '@/lib/model';
import { AuthExpiredError, BASE, enrollments, ValenceClient, whoami } from '@/lib/valence';
import { HandleFS } from '@/lib/vault/fs';
import {
  applyPending, DEFAULT_VAULT_SETTINGS, OwnerMismatchError, runVaultSync,
  type RunResult, type Stage, type VaultSettings,
} from '@/lib/vault/run';
import { lastSync, undoLast } from '@/lib/vault/sync';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = String(v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v as EventListener);
    else (el as any)[k] = v;
  }
  el.append(...children);
  return el;
}

// ---------------------------------------------------------------- state

interface Stored {
  settings: VaultSettings;
  courseIds: number[];
  /** personal MyTimetable ICS link ('' = no calendar) */
  icsUrl: string;
  /** shown while the handle is still being restored */
  vaultName: string;
}

/** granted: ready · prompt: Chrome wants a confirmation click · missing: folder gone */
type Access = 'none' | 'granted' | 'prompt' | 'missing';

const api = new ValenceClient();
let cfg: Stored = { settings: { ...DEFAULT_VAULT_SETTINGS }, courseIds: [], icsUrl: '', vaultName: '' };
let vault: FileSystemDirectoryHandle | null = null;
let access: Access = 'none';
let looksLikeVault = true;
let me: { name: string; uniqueName: string } | null = null;
let sessionChecked = false;
let courses: Course[] = [];
/** courses the popup already found to be empty: not offered here */
let emptyCourses = new Set<number>();
let busy = false;
let result: RunResult | null = null;
/** opened by "Export to Obsidian": start as soon as everything is in place */
let wantRun = location.hash === '#run';

const save = () => browser.storage.local.set({ vault: cfg });

// ---------------------------------------------------------------- vault folder handle

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

async function checkAccess(): Promise<void> {
  if (!vault) {
    access = 'none';
    return;
  }
  const perm = await (vault as any).queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') {
    access = 'prompt';
    return;
  }
  try {
    const fs = new HandleFS(vault);
    looksLikeVault = (await fs.listDirs('')).includes('.obsidian');
    access = 'granted';
  } catch {
    access = 'missing'; // folder moved, renamed or deleted
  }
}

async function chooseVault(): Promise<void> {
  try {
    vault = await (window as any).showDirectoryPicker({ id: 'vault', mode: 'readwrite' });
  } catch (ex) {
    if ((ex as DOMException).name === 'AbortError') return;
    throw ex;
  }
  await idbSet('vault', vault);
  cfg.vaultName = vault!.name;
  result = null;
  await save();
  await checkAccess();
  await showLastSync();
  refresh();
}

/** Needs a click: Chrome only shows its permission prompt after a user gesture. */
async function reconnect(): Promise<boolean> {
  if (!vault) return false;
  const perm = await (vault as any).requestPermission({ mode: 'readwrite' });
  await checkAccess();
  refresh();
  return perm === 'granted' && access === 'granted';
}

// ---------------------------------------------------------------- feedback

function log(msg: string): void {
  const el = $('log');
  el.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

function stage(text: string, cls = '', done?: number, total?: number): void {
  $('stage').textContent = text;
  $('stage').className = `status ${cls}`;
  const bar = $<HTMLProgressElement>('progress');
  bar.hidden = done === undefined;
  if (done !== undefined) {
    if (total) {
      bar.max = total;
      bar.value = done;
    } else bar.removeAttribute('value');
  }
}

function showStage(s: Stage): void {
  if (s.phase === 'scan') stage(`Reading ${s.detail}…`, '', s.done, s.total);
  else if (s.phase === 'read') stage(`Reading ${s.detail}`, '', s.done, s.total);
  else if (s.phase === 'compare') stage('Comparing with your vault…', '', 0, 0);
  else if (s.phase === 'write') stage(s.total ? `Writing ${s.done}/${s.total} · ${s.detail}` : 'Writing…', '', s.done, s.total);
  else if (s.phase === 'timetable') stage('Updating the calendar…', '', 0, 0);
  else stage('Updating course hubs…', '', 0, 0);
}

const chosenCourses = () => courses.filter((c) => cfg.courseIds.includes(c.id));
const configured = () => !!vault && cfg.courseIds.length > 0;

/** The one thing the student has to do next, if any. */
function renderNotice(): void {
  const el = $('notice');
  el.className = '';
  el.replaceChildren();
  let text = '';
  let extra: Node | null = null;
  if (!vault) {
    text = 'Step 1: choose the folder of your Obsidian vault.';
  } else if (access === 'missing') {
    el.className = 'bad';
    text = `The vault folder “${cfg.vaultName}” can no longer be found. It was probably moved, renamed or deleted — choose it again.`;
  } else if (access === 'prompt') {
    text = `Chrome needs you to confirm access to “${cfg.vaultName}” again.`;
    extra = h('div', {},
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => void act('Reconnect', async () => {
          if (await reconnect()) await maybeAutoRun();
        }) }, wantRun ? 'Reconnect vault and sync' : 'Reconnect vault')),
      h('small', {}, 'Tip: pick “Allow on every visit” in Chrome’s prompt and syncing will start by itself next time.'));
  } else if (sessionChecked && !me) {
    el.className = 'bad';
    text = 'You are not logged in to Brightspace.';
    extra = h('div', { class: 'row' },
      h('a', { href: `${BASE}/d2l/home`, target: '_blank', rel: 'noreferrer' }, 'Open Brightspace'),
      h('button', { onclick: () => void act('Session', loadSession) }, 'I am logged in — retry'));
  } else if (!cfg.courseIds.length) {
    text = 'Step 2: tick the courses you want to keep in sync, then press Sync now.';
  }
  el.hidden = !text;
  if (text) el.append(text, ...(extra ? [extra] : []));
}

function refresh(): void {
  renderNotice();
  const st = $('vault-status');
  st.className = 'status';
  if (!vault) st.textContent = 'No vault chosen yet.';
  else if (access === 'granted') {
    st.className = `status ${looksLikeVault ? 'ok' : 'warn'}`;
    st.textContent = looksLikeVault
      ? `“${vault.name}” ✓ Obsidian vault`
      : `“${vault.name}” — no .obsidian folder inside. Is this the vault root?`;
  } else if (access === 'missing') {
    st.className = 'status bad';
    st.textContent = `“${cfg.vaultName}” not found`;
  } else st.textContent = `“${cfg.vaultName}” — access needs confirming`;
  $('choose').textContent = vault ? 'Change vault folder' : 'Choose vault folder';

  const ready = !!vault && access !== 'missing' && !!me && cfg.courseIds.length > 0;
  $<HTMLButtonElement>('sync').disabled = busy || !ready;
  $('sync').textContent = busy ? 'Syncing…' : access === 'prompt' ? 'Reconnect vault and sync' : 'Sync now';
  $<HTMLButtonElement>('undo').disabled = busy || access !== 'granted';
  $<HTMLButtonElement>('choose').disabled = busy;
}

/** Run something triggered by a click; errors end up in the stage line. */
async function act(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (ex) {
    stage(`${name} failed: ${(ex as Error).message || ex}`, 'bad');
    log(`${name} failed: ${(ex as Error).stack || ex}`);
  }
  refresh();
}

// ---------------------------------------------------------------- session + courses

async function loadSession(): Promise<void> {
  const pill = $('session');
  pill.className = 'pill';
  pill.textContent = 'Checking Brightspace…';
  try {
    me = await whoami(api);
    if (me) courses = await enrollments(api);
  } catch (ex) {
    me = null;
    if (!(ex instanceof AuthExpiredError)) log(`Could not reach Brightspace: ${(ex as Error).message}`);
  }
  sessionChecked = true;
  pill.className = `pill ${me ? 'ok' : 'bad'}`;
  pill.textContent = me ? `Brightspace: ${me.name || me.uniqueName}` : 'Not logged in to Brightspace';
  renderCourses();
  refresh();
}

function renderCourses(): void {
  const list = $('course-list');
  list.replaceChildren();
  const picked = new Set(cfg.courseIds);
  const shown = courses.filter((c) => picked.has(c.id) || (c.active !== false && !emptyCourses.has(c.id)));
  for (const c of shown) {
    const box = h('input', { type: 'checkbox', checked: picked.has(c.id) });
    const row = h('label', { class: picked.has(c.id) ? 'on' : '' }, box, h('span', {}, c.name));
    box.addEventListener('change', () => {
      cfg.courseIds = box.checked ? [...new Set([...cfg.courseIds, c.id])] : cfg.courseIds.filter((id) => id !== c.id);
      row.className = box.checked ? 'on' : '';
      void save();
      refresh();
    });
    list.append(row);
  }
  if (!shown.length) {
    list.append(h('div', { class: 'empty' }, me ? 'No courses found.' : 'Log in to Brightspace to see your courses.'));
  }
}

function setAllCourses(on: boolean): void {
  const shown = courses.filter((c) => c.active !== false && !emptyCourses.has(c.id)).map((c) => c.id);
  cfg.courseIds = on ? [...new Set([...cfg.courseIds, ...shown])] : [];
  void save();
  renderCourses();
  refresh();
}

// ---------------------------------------------------------------- calendar

/** A MyTimetable subscription link: https, on mytimetable.tudelft.nl. Returns why not, or ''. */
function icsProblem(url: string): string {
  if (!url) return '';
  let u: URL;
  try {
    u = new URL(url.replace(/^webcal:/i, 'https:'));
  } catch {
    return 'This is not a link.';
  }
  if (u.hostname !== 'mytimetable.tudelft.nl') return 'Use the subscription link from mytimetable.tudelft.nl.';
  return '';
}

async function fetchIcs(url: string): Promise<string> {
  const res = await fetch(url.replace(/^webcal:/i, 'https:'), { credentials: 'omit' });
  if (!res.ok) throw new Error(`MyTimetable answered ${res.status}. Is the link still valid?`);
  const text = await res.text();
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('The link did not return a calendar. Copy the subscription link again.');
  return text;
}

function bindCalendar(): void {
  const el = $<HTMLInputElement>('ics-url');
  const st = $('ics-status');
  const show = () => {
    const problem = icsProblem(cfg.icsUrl);
    st.className = `status ${problem ? 'bad' : cfg.icsUrl ? 'ok' : ''}`;
    st.textContent = problem || (cfg.icsUrl ? '✓ calendar on' : 'off');
  };
  el.value = cfg.icsUrl;
  el.addEventListener('change', () => {
    const v = el.value.trim();
    cfg.icsUrl = icsProblem(v) ? cfg.icsUrl : v;
    if (icsProblem(v)) {
      st.className = 'status bad';
      st.textContent = icsProblem(v);
      return;
    }
    void save();
    show();
  });
  show();

  const num = (id: string, key: 'daysPast' | 'daysFuture', min: number) => {
    const n = $<HTMLInputElement>(id);
    n.value = String(cfg.settings[key]);
    n.addEventListener('change', () => {
      cfg.settings[key] = Math.min(365, Math.max(min, Math.round(Number(n.value)) || DEFAULT_VAULT_SETTINGS[key]));
      n.value = String(cfg.settings[key]);
      void save();
    });
  };
  num('days-past', 'daysPast', 0);
  num('days-future', 'daysFuture', 1);
}

// ---------------------------------------------------------------- sync

function fileList(title: string, paths: string[]): HTMLElement {
  return h('details', {}, h('summary', {}, `${title} (${paths.length})`), h('ul', {}, ...paths.map((p) => h('li', {}, p))));
}

function renderResult(): void {
  const root = $('result');
  root.replaceChildren();
  if (!result) return;
  const r = result;
  const { log: l } = r;
  const card = h('div', { class: 'card' },
    h('div', { class: 'numbers' },
      h('span', {}, h('b', {}, String(l.added.length)), 'added'),
      h('span', {}, h('b', {}, String(l.modified.length)), 'updated'),
      h('span', {}, h('b', {}, String(r.unchanged)), 'already up to date')));
  if (l.added.length) card.append(fileList('Added', l.added));
  if (l.modified.length) card.append(fileList('Updated', l.modified));
  if (l.failed.length) card.append(fileList('Could not be downloaded — will be retried next sync', l.failed.map((f) => `${f.path} (${f.reason})`)));
  if (r.timetable) {
    const t = r.timetable;
    card.append(h('div', { class: 'hint' },
      `Calendar: ${t.instances} classes · ${t.written.length} note(s) written · ${t.pruned.length} removed` +
      (t.kept.length ? ` · ${t.kept.length} cancelled class(es) kept because they have your notes` : '')));
    if (t.written.length) card.append(fileList('Calendar notes written', t.written));
  } else if (r.timetableError) {
    card.append(h('div', { class: 'warn' }, `Calendar not updated: ${r.timetableError}`));
  }
  if (r.hubs?.written.length) card.append(fileList('Course hub notes refreshed', r.hubs.written));
  if (r.skippedCourses.length) {
    card.append(fileList('Courses that could not be read', r.skippedCourses.map((s) => `${s.name} — ${s.reason}`)));
  }
  root.append(card);

  const pending = (title: string, note: string, paths: string[], label: string, what: 'remove' | 'overwrite') => {
    if (!paths.length) return;
    root.append(h('div', { class: 'card attention' },
      h('div', { class: 'warn' }, title),
      h('div', { class: 'hint' }, note),
      h('div', { class: 'row' }, h('button', {
        class: 'danger',
        onclick: () => void act(label, async () => {
          if (!vault || busy) return;
          const fs = new HandleFS(vault);
          const done = await applyPending(api, fs, cfg.settings, r.plan, what);
          log(`${label}: ${done.removed.length} removed, ${done.modified.length} overwritten`);
          if (what === 'remove') r.pendingRemove = [];
          else r.pendingEdited = [];
          renderResult();
          await showLastSync();
        }),
      }, label)),
      fileList('Files', paths)));
  };
  pending(`${r.pendingRemove.length} file(s) are no longer on Brightspace`,
    'They were left in your vault. Remove them if you no longer need them (they are backed up first).',
    r.pendingRemove.map((a) => a.path), 'Remove them from the vault', 'remove');
  pending(`${r.pendingEdited.length} note(s) were edited by hand and differ from Brightspace`,
    'They were not touched. Your own notes belong in the Courses/ hub notes; the Brightspace folder is a mirror.',
    r.pendingEdited.map((a) => a.path), 'Overwrite with the Brightspace version', 'overwrite');
}

async function showLastSync(): Promise<void> {
  if (!vault || access !== 'granted') {
    $('last').textContent = '';
    return;
  }
  const last = await lastSync(new HandleFS(vault));
  $('last').textContent = last ? `Last change: ${last.ts.replace('T', ' ')} UTC` : '';
}

async function runSync(fromClick: boolean): Promise<void> {
  if (busy || !vault) return;
  if (access === 'prompt') {
    // Without a click Chrome will not show its prompt: the notice has the button.
    if (!fromClick || !(await reconnect())) return;
  }
  if (access !== 'granted' || !me || !cfg.courseIds.length) return;
  busy = true;
  wantRun = false;
  result = null;
  renderResult();
  refresh();
  try {
    const fs = new HandleFS(vault);
    result = await runVaultSync(api, fs, chosenCourses(), cfg.settings, me.uniqueName, showStage,
      cfg.icsUrl ? () => fetchIcs(cfg.icsUrl) : undefined);
    const { log: l } = result;
    for (const w of result.warnings) log(w);
    for (const f of l.failed) log(`failed: ${f.path} (${f.reason})`);
    const changed = l.added.length + l.modified.length;
    stage(changed
      ? `Vault updated: ${l.added.length} added, ${l.modified.length} updated.`
      : 'Your vault is already up to date.', l.failed.length ? 'warn' : 'ok');
    await browser.storage.local.set({ vaultLast: { at: Date.now(), added: l.added.length, updated: l.modified.length } });
  } catch (ex) {
    if (ex instanceof AuthExpiredError) {
      me = null;
      stage('Your Brightspace session expired — log in again, then press Sync now.', 'bad');
    } else if (ex instanceof OwnerMismatchError) {
      stage(`${ex.message} Use a different vault folder for this account.`, 'bad');
    } else if (['NotFoundError', 'NotAllowedError'].includes((ex as DOMException)?.name)) {
      await checkAccess();
      stage('The vault folder is no longer accessible — see the note at the top.', 'bad');
    } else {
      stage(`Sync failed: ${(ex as Error).message || ex}`, 'bad');
      log(`Sync failed: ${(ex as Error).stack || ex}`);
    }
  } finally {
    busy = false;
    renderResult();
    await showLastSync().catch(() => {});
    refresh();
  }
}

/** Start by itself when the popup asked for it and nothing is missing. */
async function maybeAutoRun(): Promise<void> {
  if (wantRun && configured() && access === 'granted' && me && !busy) await runSync(false);
}

async function runUndo(): Promise<void> {
  if (!vault || busy) return;
  const fs = new HandleFS(vault);
  const last = await lastSync(fs);
  if (!last) {
    stage('Nothing to undo.');
    return;
  }
  if (!confirm(`Undo the sync from ${last.ts.replace('T', ' ')} UTC?\n\n` +
    `${last.added.length} added file(s) will be deleted and ${last.backedUp.length} changed/removed file(s) restored.`)) return;
  const res = await undoLast(fs);
  if (!res) return;
  result = null;
  renderResult();
  for (const p of res.lost) log(`not restorable (no backup): ${p}`);
  stage(`Undone: ${res.deleted} file(s) deleted, ${res.restored} restored.`, 'ok');
  await showLastSync();
}

// ---------------------------------------------------------------- wiring

function bindSettings(): void {
  const text = (id: string, key: 'outName' | 'virtRoot', clean: (v: string) => string) => {
    const el = $<HTMLInputElement>(id);
    el.value = cfg.settings[key];
    el.addEventListener('change', () => {
      cfg.settings[key] = clean(el.value);
      el.value = cfg.settings[key];
      result = null;
      renderResult();
      void save();
    });
  };
  const check = (id: string, key: 'virtFolder' | 'hubs') => {
    const el = $<HTMLInputElement>(id);
    el.checked = cfg.settings[key];
    el.addEventListener('change', () => {
      cfg.settings[key] = el.checked;
      void save();
    });
  };
  text('out-name', 'outName', (v) => v.replace(/[\\/:*?"<>|]/g, '').trim() || DEFAULT_VAULT_SETTINGS.outName);
  text('virt-root', 'virtRoot', (v) => v.trim());
  check('virt-folder', 'virtFolder');
  check('hubs', 'hubs');

  $('choose').addEventListener('click', () => void act('Choose vault', chooseVault));
  $('courses-all').addEventListener('click', () => setAllCourses(true));
  $('courses-none').addEventListener('click', () => setAllCourses(false));
  $('sync').addEventListener('click', () => void runSync(true));
  $('undo').addEventListener('click', () => void act('Undo', runUndo));
}

window.addEventListener('beforeunload', (e) => {
  if (busy) e.preventDefault();
});

// "Export to Obsidian" pressed again while this tab is already open.
browser.runtime.onMessage.addListener((msg: { type?: string }) => {
  if (msg?.type !== 'vault-run') return;
  wantRun = true;
  refresh();
  void (async () => {
    await checkAccess();
    if (!me) await loadSession();
    refresh();
    await maybeAutoRun();
  })();
});

async function init(): Promise<void> {
  const stored = await browser.storage.local.get(['vault', 'popup']);
  const saved = stored.vault as Partial<Stored> | undefined;
  if (saved) {
    cfg = {
      settings: { ...DEFAULT_VAULT_SETTINGS, ...saved.settings },
      courseIds: saved.courseIds ?? [],
      icsUrl: saved.icsUrl ?? '',
      vaultName: saved.vaultName ?? '',
    };
  }
  const known = (stored.popup as { content?: Record<string, { has: boolean }> } | undefined)?.content ?? {};
  emptyCourses = new Set(Object.entries(known).filter(([, v]) => v.has === false).map(([id]) => Number(id)));

  bindSettings();
  bindCalendar();
  try {
    vault = (await idbGet<FileSystemDirectoryHandle>('vault')) ?? null;
    await checkAccess();
  } catch {
    vault = null;
  }
  refresh();
  await showLastSync().catch(() => {});
  await loadSession();
  await maybeAutoRun();
}

void init();
