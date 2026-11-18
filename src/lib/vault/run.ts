/**
 * One-click vault sync: read the chosen courses from Brightspace and bring
 * the vault up to date. New files are added and changed files are updated in
 * place; nothing is copied twice. What would destroy something (files gone
 * from Brightspace, notes the student edited by hand) is left untouched and
 * reported as "pending", for the student to decide.
 */

import type { Course, ScannedCourse, Selection } from '../model';
import { hydrate, scanCourse, type ScanState, type TextCache } from '../scan';
import { type Api, AuthExpiredError } from '../valence';
import { addVaultHome, buildVault, type BuildOptions } from './build';
import type { VaultFS } from './fs';
import { syncHubs, type HubsResult } from './hubs';
import { setupFullCalendar, syncTimetable, type TimetableResult } from './timetable';
import {
  applyPlan, groupOf, loadManifest, planSync, pruneBackups, STATE_DIR,
  type Action, type Group, type Plan, type SyncLog,
} from './sync';

export interface VaultSettings {
  /** folder inside the vault that holds the Brightspace clone */
  outName: string;
  /** VirtFolder `Folders:` parent links + course hub links */
  virtFolder: boolean;
  virtRoot: string;
  /** `Courses/` hub notes: where the student's own notes live */
  hubs: boolean;
  /** timetable window around today, in days */
  daysPast: number;
  daysFuture: number;
}

export const DEFAULT_VAULT_SETTINGS: VaultSettings = {
  outName: 'Brightspace', virtFolder: true, virtRoot: '! Index', hubs: true,
  daysPast: 14, daysFuture: 120,
};

export interface Stage {
  phase: 'scan' | 'read' | 'compare' | 'write' | 'timetable' | 'hubs';
  /** course being read, or file being written */
  detail: string;
  done: number;
  total: number;
}

export interface RunResult {
  log: SyncLog;
  plan: Plan;
  unchanged: number;
  /** left untouched until the student confirms */
  pendingRemove: Action[];
  pendingEdited: Action[];
  hubs: HubsResult | null;
  /** null when no timetable feed is configured */
  timetable: TimetableResult | null;
  timetableError: string;
  skippedCourses: { name: string; reason: string }[];
  warnings: string[];
  /** Cancel was pressed while files were written: the rest waits for the next sync. */
  cancelled: boolean;
}

/** Cancel pressed before anything was written to the vault. */
export class SyncCancelledError extends Error {
  constructor() {
    super('Sync cancelled');
  }
}

export class OwnerMismatchError extends Error {
  constructor(public owner: string, public current: string) {
    super(`This vault is synced for ${owner}, but you are logged in to Brightspace as ${current}.`);
  }
}

/** Everything a course has, except video/audio files (they stay links). */
const EVERYTHING: Selection = {
  categories: { documents: true, videos: true, pages: true, links: true, other: true },
  announcements: true, assignments: true, grades: true, excluded: new Set(), maxFileMB: 0,
};

const APPLY = { maxBackupBytes: 50 * 1024 * 1024, allowNoBackup: true, maxFileBytes: 0 };
const SAFE: Record<Group, boolean> = {
  add: true, modify: true, overwriteEdited: false, remove: false, removeEdited: false,
};

async function readJson<T>(fs: VaultFS, name: string, fallback: T): Promise<T> {
  try {
    const text = await fs.readText(`${STATE_DIR}/${name}`);
    return text ? { ...fallback, ...JSON.parse(text) } : fallback;
  } catch {
    return fallback;
  }
}

export async function runVaultSync(
  api: Api,
  fs: VaultFS,
  courses: Course[],
  settings: VaultSettings,
  owner: string,
  onStage: (stage: Stage) => void = () => {},
  /** returns the MyTimetable ICS feed; omitted when the student has not set one up */
  loadIcs?: () => Promise<string>,
  /** Cancel: stops between steps; once writing started, the vault is left consistent. */
  signal?: AbortSignal,
): Promise<RunResult> {
  const stopped = () => !!signal?.aborted;
  const manifest = await loadManifest(fs);
  if (manifest.owner && owner && manifest.owner !== owner) throw new OwnerMismatchError(manifest.owner, owner);
  if (owner) manifest.owner = owner;

  const state = await readJson<ScanState>(fs, 'state.json', { names: {}, descs: {} });
  const texts = await readJson<TextCache>(fs, 'textcache.json', {});
  const opts: BuildOptions = { ...settings, skipMedia: true };

  const scans: ScannedCourse[] = [];
  const skippedCourses: RunResult['skippedCourses'] = [];
  const warnings: string[] = [];
  let i = 0;
  for (const course of courses) {
    if (stopped()) break;
    const stage = { done: i++, total: courses.length };
    try {
      onStage({ phase: 'scan', detail: course.name, ...stage });
      const sc = await scanCourse(api, course, state, () => {}, { toc: true });
      warnings.push(...sc.errors.map((e) => `${sc.code}: ${e}`));
      const errors = await hydrate(api, course.id, sc.tree,
        (title) => onStage({ phase: 'read', detail: `${course.name} — ${title}`, ...stage }), texts);
      // A course read halfway must not be compared: its notes would lose their text.
      if (stopped()) break;
      warnings.push(...errors.map((e) => `${sc.code}: could not read ${e}`));
      scans.push(sc);
    } catch (ex) {
      if (ex instanceof AuthExpiredError) throw ex;
      if (stopped()) break;
      skippedCourses.push({ name: course.name, reason: (ex as Error).message || String(ex) });
    }
  }

  const saveCaches = async () => {
    await fs.write(`${STATE_DIR}/state.json`, JSON.stringify(state));
    await fs.write(`${STATE_DIR}/textcache.json`, JSON.stringify(texts));
  };
  if (stopped()) {
    // Nothing written yet. Keep what was read so the next sync is quicker.
    await saveCaches();
    throw new SyncCancelledError();
  }

  onStage({ phase: 'compare', detail: '', done: 0, total: 0 });
  const build = buildVault(scans, EVERYTHING, opts);
  const codes = scans.map((s) => s.code);
  build.homes = addVaultHome(build, manifest.courses, codes, opts, new Date().toISOString().slice(0, 10));
  const plan = await planSync(fs, settings.outName, build, manifest, codes);

  const log = await applyPlan(fs, settings.outName, plan, manifest, SAFE,
    (cid, tid) => api.fetchFile(cid, tid), APPLY,
    (done, total, path) => onStage({ phase: 'write', detail: path, done, total }));

  await saveCaches();
  await pruneBackups(fs);

  const pendingRemove = plan.actions.filter((a) => a.op === 'remove');
  const pendingEdited = plan.actions.filter((a) => groupOf(a) === 'overwriteEdited');
  if (stopped()) {
    // Files that were not fetched are not in the manifest: the next sync adds them.
    log.failed = log.failed.filter((f) => !/cancel|abort/i.test(f.reason));
    return {
      log, plan, hubs: null, timetable: null, timetableError: '', skippedCourses, warnings,
      unchanged: plan.unchanged, pendingRemove, pendingEdited, cancelled: true,
    };
  }

  // Same order as upstream: Brightspace, then the timetable (it links to the
  // course folders), then the hubs (they count the upcoming classes).
  let timetable: TimetableResult | null = null;
  let timetableError = '';
  if (loadIcs) {
    onStage({ phase: 'timetable', detail: '', done: 0, total: 0 });
    try {
      timetable = await syncTimetable(fs, await loadIcs(), settings);
      timetable.calendarSetup = await setupFullCalendar(fs, timetable.categories);
    } catch (ex) {
      // The calendar must never cost the student the course sync.
      timetableError = (ex as Error).message || String(ex);
    }
  }

  if (settings.virtFolder && settings.virtRoot) await ensureRootNote(fs, settings);

  let hubs: HubsResult | null = null;
  if (settings.hubs) {
    onStage({ phase: 'hubs', detail: '', done: 0, total: 0 });
    hubs = await syncHubs(fs, settings.outName, settings.virtFolder ? settings.virtRoot : '');
  }
  return {
    log, plan, hubs, timetable, timetableError, skippedCourses, warnings,
    unchanged: plan.unchanged, pendingRemove, pendingEdited, cancelled: false,
  };
}

/**
 * The VirtFolder tree hangs off the root note (`! Index`): every generated
 * note points at it. Create it when the vault has none, never touch it after.
 */
export async function ensureRootNote(fs: VaultFS, settings: VaultSettings): Promise<boolean> {
  const want = `${settings.virtRoot}.md`.toLowerCase();
  if ((await fs.listFiles('')).some((n) => n.toLowerCase() === want)) return false;
  const lines = ['---', `title: "${settings.virtRoot.replace(/"/g, "'")}"`, 'tags: [moc]', '---',
    `# ${settings.virtRoot.replace(/^!\s*/, '')}`, '',
    'Root of the folder tree (VirtFolder). Notes that list this note under `Folders:` appear below it.', '',
    `- [[${settings.outName}/! ${settings.outName}|📚 Brightspace]]`];
  if (settings.hubs) lines.push('- [[! Course Notes|📝 Course Notes]]');
  await fs.write(`${settings.virtRoot}.md`, `${lines.join('\n')}\n`);
  return true;
}

/** Carry out what a sync left pending, after the student confirmed it. */
export async function applyPending(
  api: Api,
  fs: VaultFS,
  settings: VaultSettings,
  plan: Plan,
  what: 'remove' | 'overwrite',
): Promise<SyncLog> {
  const groups: Record<Group, boolean> = {
    add: false, modify: false,
    overwriteEdited: what === 'overwrite',
    remove: what === 'remove', removeEdited: what === 'remove',
  };
  const manifest = await loadManifest(fs);
  const log = await applyPlan(fs, settings.outName, plan, manifest, groups,
    (cid, tid) => api.fetchFile(cid, tid), APPLY);
  await pruneBackups(fs);
  if (settings.hubs) await syncHubs(fs, settings.outName, settings.virtFolder ? settings.virtRoot : '');
  return log;
}
