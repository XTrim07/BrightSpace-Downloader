/**
 * Transactional vault sync: plan (nothing written) -> apply (backup first)
 * -> undo. State lives in `<vault>/.brightspace-sync/`, which Obsidian ignores.
 *
 * Safety rules, mirroring the old sync.sh review model:
 * - nothing is written before the user has seen the plan;
 * - every overwritten or removed file is backed up first;
 * - removals only ever touch files this tool wrote (tracked in the manifest);
 * - the caller decides per group what to apply; destructive groups default to no.
 */

import { sha256Hex, utcStamp } from '../util';
import type { BuildResult, CourseHome, Desired } from './build';
import type { VaultFS } from './fs';

export const STATE_DIR = '.brightspace-sync';

export interface ManifestFile {
  kind: 'text' | 'bin';
  size: number;
  mtime: number;
  /** text: sha256 of what we wrote */
  sha?: string;
  /** bin: Brightspace LastModifiedDate of the topic we downloaded */
  lastModified?: string;
}

export interface Manifest {
  version: 1;
  /** keyed by path relative to the output folder */
  files: Record<string, ManifestFile>;
  /** keyed by course code */
  courses: Record<string, CourseHome>;
  /** Brightspace user this vault is synced for; a different user is refused */
  owner?: string;
}

export const emptyManifest = (): Manifest => ({ version: 1, files: {}, courses: {} });

export async function loadManifest(fs: VaultFS): Promise<Manifest> {
  const text = await fs.readText(`${STATE_DIR}/manifest.json`);
  if (!text) return emptyManifest();
  try {
    const m = JSON.parse(text);
    return { version: 1, files: m.files ?? {}, courses: m.courses ?? {}, owner: m.owner };
  } catch {
    return emptyManifest();
  }
}

export type Group = 'add' | 'modify' | 'overwriteEdited' | 'remove' | 'removeEdited';

export interface Action {
  path: string;
  op: 'add' | 'modify' | 'remove';
  kind: 'text' | 'bin';
  /** the file on disk no longer matches what this tool last wrote */
  handEdited: boolean;
  /** size of the file currently on disk (modify/remove) */
  size: number;
  diff?: string;
}

export interface Plan {
  actions: Action[];
  unchanged: number;
  /** existing files that already match: recorded in the manifest on apply */
  adopt: Record<string, ManifestFile>;
  /** manifest entries whose file vanished from disk */
  forget: string[];
  /** files inside synced course folders this tool does not know about (never touched) */
  untracked: string[];
  desired: Map<string, Desired>;
  homes: CourseHome[];
}

export function groupOf(a: Action): Group {
  if (a.op === 'add') return 'add';
  if (a.op === 'modify') return a.handEdited ? 'overwriteEdited' : 'modify';
  return a.handEdited ? 'removeEdited' : 'remove';
}

/** The top note carries a `Synced YYYY-MM-DD.` stamp; a date-only change is noise. */
function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/^Synced \d{4}-\d{2}-\d{2}\./m, 'Synced .');
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function walkFiles(fs: VaultFS, dir: string, out: string[]): Promise<void> {
  for (const f of await fs.listFiles(dir)) out.push(`${dir}/${f}`);
  for (const d of await fs.listDirs(dir)) await walkFiles(fs, `${dir}/${d}`, out);
}

/**
 * Compare the desired output with the vault. `scannedCodes` are the courses
 * scanned this run: only their folders are candidates for removals.
 */
export async function planSync(
  fs: VaultFS,
  outName: string,
  build: BuildResult,
  manifest: Manifest,
  scannedCodes: string[],
): Promise<Plan> {
  const plan: Plan = {
    actions: [], unchanged: 0, adopt: {}, forget: [], untracked: [],
    desired: build.files, homes: build.homes,
  };
  for (const [path, want] of build.files) {
    const full = `${outName}/${path}`;
    const st = await fs.stat(full);
    const known = manifest.files[path];
    if (!st) {
      plan.actions.push({ path, op: 'add', kind: want.kind === 'text' ? 'text' : 'bin', handEdited: false, size: 0 });
      continue;
    }
    if (want.kind === 'text') {
      const cur = (await fs.readText(full)) ?? '';
      const sha = await sha256Hex(cur);
      if (normalize(cur) === normalize(want.text)) {
        plan.unchanged++;
        plan.adopt[path] = { kind: 'text', size: st.size, mtime: st.mtime, sha };
      } else {
        plan.actions.push({
          path, op: 'modify', kind: 'text', size: st.size,
          handEdited: !!known?.sha && known.sha !== sha,
          diff: lineDiff(cur, want.text),
        });
      }
      continue;
    }
    const touched = !!known && (known.size !== st.size || known.mtime !== st.mtime);
    let same: boolean;
    if (want.kind === 'bytes') {
      const cur = st.size === want.bytes.length ? await fs.readBytes(full) : null;
      same = !!cur && sameBytes(cur, want.bytes);
    } else {
      // Not downloaded yet: trust Brightspace's LastModifiedDate. A file that
      // exists but was never tracked is adopted as current (first run on an
      // existing vault).
      same = !known || known.lastModified === want.lastModified;
    }
    if (same) {
      plan.unchanged++;
      plan.adopt[path] = known && !touched
        ? known
        : { kind: 'bin', size: st.size, mtime: st.mtime, lastModified: want.lastModified };
    } else {
      plan.actions.push({ path, op: 'modify', kind: 'bin', size: st.size, handEdited: touched });
    }
  }

  const scope = new Set<string>(build.homes.map((h) => h.vname));
  for (const code of scannedCodes) {
    const prev = manifest.courses[code];
    if (prev) scope.add(prev.vname);
  }
  const inScope = (path: string) => scope.has(path.split('/')[0]);
  for (const [path, known] of Object.entries(manifest.files)) {
    if (build.files.has(path) || !inScope(path)) continue;
    const st = await fs.stat(`${outName}/${path}`);
    if (!st) {
      plan.forget.push(path);
      continue;
    }
    let handEdited = known.size !== st.size || known.mtime !== st.mtime;
    if (handEdited && known.kind === 'text' && known.sha) {
      handEdited = (await sha256Hex((await fs.readText(`${outName}/${path}`)) ?? '')) !== known.sha;
    }
    plan.actions.push({ path, op: 'remove', kind: known.kind, handEdited, size: st.size });
  }
  for (const vname of scope) {
    const found: string[] = [];
    await walkFiles(fs, `${outName}/${vname}`, found);
    for (const full of found) {
      const path = full.slice(outName.length + 1);
      if (!build.files.has(path) && !manifest.files[path]) plan.untracked.push(path);
    }
  }
  return plan;
}

export interface ApplyOptions {
  /** files larger than this are not copied to the backup folder */
  maxBackupBytes: number;
  /** overwrite/remove files too large to back up anyway */
  allowNoBackup: boolean;
  /** skip downloads larger than this (0 = no limit) */
  maxFileBytes: number;
}

export interface SyncLog {
  ts: string;
  outName: string;
  added: string[];
  modified: string[];
  removed: string[];
  /** modified/removed paths that have a copy under backups/<ts>/files/ */
  backedUp: string[];
  skipped: { path: string; reason: string }[];
  failed: { path: string; reason: string }[];
  undone: boolean;
}

export type Fetcher = (courseId: number, topicId: number | string) => Promise<Response>;

export async function applyPlan(
  fs: VaultFS,
  outName: string,
  plan: Plan,
  manifest: Manifest,
  groups: Record<Group, boolean>,
  fetchFile: Fetcher,
  opts: ApplyOptions,
  onProgress: (done: number, total: number, path: string) => void = () => {},
): Promise<SyncLog> {
  // One log + backup folder per sync; never reuse a stamp from the same second.
  let ts = utcStamp();
  for (let n = 2; await fs.stat(`${STATE_DIR}/logs/${ts}.json`); n++) ts = `${utcStamp()}_${n}`; // '_' sorts after '.', keeping logs in order
  const backupDir = `${STATE_DIR}/backups/${ts}`;
  const log: SyncLog = {
    ts, outName, added: [], modified: [], removed: [], backedUp: [],
    skipped: [], failed: [], undone: false,
  };
  const chosen = plan.actions.filter((a) => groups[groupOf(a)]);
  if (chosen.length) await fs.write(`${backupDir}/manifest.prev.json`, JSON.stringify(manifest));

  Object.assign(manifest.files, plan.adopt);
  for (const path of plan.forget) delete manifest.files[path];

  let done = 0;
  for (const a of chosen) {
    onProgress(done++, chosen.length, a.path);
    const full = `${outName}/${a.path}`;
    try {
      if (a.op !== 'add') {
        if (a.size <= opts.maxBackupBytes) {
          await fs.copy(full, `${backupDir}/files/${a.path}`);
          log.backedUp.push(a.path);
        } else if (!opts.allowNoBackup) {
          log.skipped.push({ path: a.path, reason: 'too large to back up' });
          continue;
        }
      }
      if (a.op === 'remove') {
        await fs.remove(full);
        delete manifest.files[a.path];
        log.removed.push(a.path);
        continue;
      }
      const want = plan.desired.get(a.path)!;
      let entry: ManifestFile;
      if (want.kind === 'text') {
        await fs.write(full, want.text);
        entry = { kind: 'text', size: 0, mtime: 0, sha: await sha256Hex(want.text) };
      } else {
        if (want.kind === 'bytes') {
          await fs.write(full, want.bytes);
        } else {
          const res = await fetchFile(want.courseId, want.topicId);
          const len = Number(res.headers.get('content-length')) || 0;
          const tooBig = opts.maxFileBytes > 0 && len > opts.maxFileBytes;
          if (!res.ok || !res.body || tooBig) {
            await res.body?.cancel().catch(() => {});
            if (tooBig) log.skipped.push({ path: a.path, reason: 'over the file size limit' });
            else log.failed.push({ path: a.path, reason: `http-${res.status}` });
            continue;
          }
          await fs.write(full, res.body);
        }
        entry = { kind: 'bin', size: 0, mtime: 0, lastModified: want.lastModified };
      }
      const st = await fs.stat(full);
      entry.size = st?.size ?? 0;
      entry.mtime = st?.mtime ?? 0;
      manifest.files[a.path] = entry;
      (a.op === 'add' ? log.added : log.modified).push(a.path);
    } catch (ex) {
      log.failed.push({ path: a.path, reason: (ex as Error).message || String(ex) });
    }
  }
  onProgress(chosen.length, chosen.length, '');
  for (const h of plan.homes) manifest.courses[h.code] = h;
  await fs.write(`${STATE_DIR}/manifest.json`, JSON.stringify(manifest, null, 1));
  if (chosen.length) await fs.write(`${STATE_DIR}/logs/${ts}.json`, JSON.stringify(log, null, 1));
  return log;
}

/** Most recent sync that changed something and has not been undone. */
export async function lastSync(fs: VaultFS): Promise<SyncLog | null> {
  const names = (await fs.listFiles(`${STATE_DIR}/logs`)).filter((n) => n.endsWith('.json'));
  for (const name of names.sort().reverse()) {
    try {
      const log = JSON.parse((await fs.readText(`${STATE_DIR}/logs/${name}`)) || '') as SyncLog;
      // Old backups are pruned: a sync can only be undone while its backup exists.
      if (!log.undone && (await fs.stat(`${STATE_DIR}/backups/${log.ts}/manifest.prev.json`))) return log;
    } catch {
      /* unreadable log: skip */
    }
  }
  return null;
}

/** Keep the backups of the last few syncs only, so they never pile up. */
export async function pruneBackups(fs: VaultFS, keep = 3): Promise<void> {
  const dirs = (await fs.listDirs(`${STATE_DIR}/backups`)).sort();
  for (const dir of dirs.slice(0, Math.max(0, dirs.length - keep))) {
    await fs.removeTree(`${STATE_DIR}/backups/${dir}`);
  }
}

export interface UndoResult {
  ts: string;
  deleted: number;
  restored: number;
  /** overwritten/removed without a backup: cannot be brought back */
  lost: string[];
}

/** Revert the last sync: delete what it added, restore what it changed or removed. */
export async function undoLast(fs: VaultFS): Promise<UndoResult | null> {
  const log = await lastSync(fs);
  if (!log) return null;
  const backupDir = `${STATE_DIR}/backups/${log.ts}`;
  for (const path of log.added) await fs.remove(`${log.outName}/${path}`);
  const backed = new Set(log.backedUp);
  for (const path of backed) await fs.copy(`${backupDir}/files/${path}`, `${log.outName}/${path}`);
  const prev = await fs.readText(`${backupDir}/manifest.prev.json`);
  if (prev) {
    // Restored files get a new mtime: refresh it so they are not seen as hand-edited.
    const m = JSON.parse(prev) as Manifest;
    for (const path of backed) {
      const st = await fs.stat(`${log.outName}/${path}`);
      if (st && m.files?.[path]) Object.assign(m.files[path], { size: st.size, mtime: st.mtime });
    }
    await fs.write(`${STATE_DIR}/manifest.json`, JSON.stringify(m, null, 1));
  }
  log.undone = true;
  await fs.write(`${STATE_DIR}/logs/${log.ts}.json`, JSON.stringify(log, null, 1));
  return {
    ts: log.ts,
    deleted: log.added.length,
    restored: backed.size,
    lost: [...log.modified, ...log.removed].filter((p) => !backed.has(p)),
  };
}

/** Compact unified-style line diff for the preview. */
export function lineDiff(before: string, after: string, context = 2): string {
  const a = before.replace(/\r\n/g, '\n').split('\n');
  const b = after.replace(/\r\n/g, '\n').split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const x = a.slice(pre, a.length - suf);
  const y = b.slice(pre, b.length - suf);
  type Op = [' ' | '-' | '+', string];
  let mid: Op[];
  if (x.length * y.length > 4_000_000) {
    mid = [...x.map((l): Op => ['-', l]), ...y.map((l): Op => ['+', l])];
  } else {
    const w = y.length + 1;
    const lcs = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        lcs[i * w + j] = x[i] === y[j]
          ? lcs[(i + 1) * w + j + 1] + 1
          : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    mid = [];
    let i = 0;
    let j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) mid.push([' ', x[i++]]), j++;
      else if (j >= y.length || (i < x.length && lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) mid.push(['-', x[i++]]);
      else mid.push(['+', y[j++]]);
    }
  }
  const ops: Op[] = [
    ...a.slice(Math.max(0, pre - context), pre).map((l): Op => [' ', l]),
    ...mid,
    ...a.slice(a.length - suf, a.length - suf + context).map((l): Op => [' ', l]),
  ];
  const out: string[] = [];
  let gap = false;
  ops.forEach(([sign, line], k) => {
    const near = sign !== ' ' ||
      ops.slice(Math.max(0, k - context), k + context + 1).some(([s]) => s !== ' ');
    if (near) {
      if (gap && out.length) out.push('  ...');
      gap = false;
      out.push(`${sign} ${line}`);
    } else gap = true;
  });
  return out.join('\n');
}
