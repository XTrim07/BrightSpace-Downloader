import { describe, expect, it } from 'vitest';
import type { BuildResult, Desired } from '../src/lib/vault/build';
import { MemoryFS } from '../src/lib/vault/fs';
import {
  applyPlan, emptyManifest, groupOf, lineDiff, loadManifest, planSync, undoLast,
  type Group,
} from '../src/lib/vault/sync';

const OUT = 'Brightspace';
const home = { code: 'C1', vname: 'C1 - Course', entries: 1, files: 1 };
const groups = (on: Partial<Record<Group, boolean>> = {}): Record<Group, boolean> => ({
  add: true, modify: true, overwriteEdited: false, remove: false, removeEdited: false, ...on,
});
const opts = { maxBackupBytes: 1024, allowNoBackup: false, maxFileBytes: 0 };

function build(files: Record<string, Desired>): BuildResult {
  return { files: new Map(Object.entries(files)), homes: [home] };
}
const text = (t: string): Desired => ({ kind: 'text', text: t });
const remote = (lastModified: string, topicId = 1): Desired => ({ kind: 'remote', courseId: 1, topicId, lastModified });
const fetcher = (body = 'PDF-BYTES', status = 200) => async () => new Response(body, { status });
const read = async (fs: MemoryFS, p: string) => fs.readText(`${OUT}/${p}`);

async function sync(fs: MemoryFS, b: BuildResult, g = groups(), f = fetcher()) {
  const manifest = await loadManifest(fs);
  const plan = await planSync(fs, OUT, b, manifest, ['C1']);
  const log = await applyPlan(fs, OUT, plan, manifest, g, f, opts);
  return { plan, log };
}

describe('vault sync', () => {
  it('first sync adds everything, second sync is a no-op', async () => {
    const fs = new MemoryFS();
    const b = build({ 'C1 - Course/a.md': text('one\n'), 'C1 - Course/f.pdf': remote('d1') });
    const first = await sync(fs, b);
    expect(first.plan.actions.map((a) => a.op)).toEqual(['add', 'add']);
    expect(first.log.added).toHaveLength(2);
    expect(await read(fs, 'C1 - Course/f.pdf')).toBe('PDF-BYTES');
    const second = await sync(fs, b);
    expect(second.plan.actions).toEqual([]);
    expect(second.plan.unchanged).toBe(2);
  });

  it('adopts an existing vault without rewriting or re-downloading', async () => {
    const fs = new MemoryFS();
    fs.set(`${OUT}/C1 - Course/a.md`, 'one\n');
    fs.set(`${OUT}/C1 - Course/f.pdf`, 'OLD-PDF');
    fs.set(`${OUT}/C1 - Course/mine.md`, 'my own note');
    const b = build({ 'C1 - Course/a.md': text('one\n'), 'C1 - Course/f.pdf': remote('d1') });
    const { plan } = await sync(fs, b, groups({ remove: true, removeEdited: true }));
    expect(plan.actions).toEqual([]);
    expect(plan.untracked).toEqual(['C1 - Course/mine.md']);
    expect(await read(fs, 'C1 - Course/f.pdf')).toBe('OLD-PDF');
    expect(await read(fs, 'C1 - Course/mine.md')).toBe('my own note');
    const m = await loadManifest(fs);
    expect(Object.keys(m.files).sort()).toEqual(['C1 - Course/a.md', 'C1 - Course/f.pdf']);
    expect(m.courses.C1).toEqual(home);
  });

  it('ignores a date-only change of the Synced stamp', async () => {
    const fs = new MemoryFS();
    await sync(fs, build({ '! Brightspace.md': text('# Top\nSynced 2026-11-11. One note\n') }));
    const { plan } = await sync(fs, build({ '! Brightspace.md': text('# Top\nSynced 2026-11-12. One note\n') }));
    expect(plan.actions).toEqual([]);
  });

  it('updates changed files, backs them up, and undo restores everything', async () => {
    const fs = new MemoryFS();
    await sync(fs, build({ 'C1 - Course/a.md': text('one\n'), 'C1 - Course/f.pdf': remote('d1'), 'C1 - Course/gone.md': text('x\n') }));
    const next = build({ 'C1 - Course/a.md': text('two\n'), 'C1 - Course/f.pdf': remote('d2'), 'C1 - Course/new.md': text('n\n') });
    const { plan, log } = await sync(fs, next, groups({ remove: true }), fetcher('NEW-PDF'));
    expect(plan.actions.map((a) => `${a.op}:${groupOf(a)}:${a.path}`).sort()).toEqual([
      'add:add:C1 - Course/new.md', 'modify:modify:C1 - Course/a.md',
      'modify:modify:C1 - Course/f.pdf', 'remove:remove:C1 - Course/gone.md',
    ]);
    expect(plan.actions.find((a) => a.path.endsWith('a.md'))!.diff).toBe('- one\n+ two\n  ');
    expect(log.backedUp.sort()).toEqual(['C1 - Course/a.md', 'C1 - Course/f.pdf', 'C1 - Course/gone.md']);
    expect(await read(fs, 'C1 - Course/a.md')).toBe('two\n');
    expect(await read(fs, 'C1 - Course/f.pdf')).toBe('NEW-PDF');
    expect(await read(fs, 'C1 - Course/gone.md')).toBeNull();

    const undone = await undoLast(fs);
    expect(undone).toMatchObject({ deleted: 1, restored: 3, lost: [] });
    expect(await read(fs, 'C1 - Course/a.md')).toBe('one\n');
    expect(await read(fs, 'C1 - Course/f.pdf')).toBe('PDF-BYTES');
    expect(await read(fs, 'C1 - Course/gone.md')).toBe('x\n');
    expect(await read(fs, 'C1 - Course/new.md')).toBeNull();
    // after undo the vault is clean again relative to the restored manifest
    const again = await planSync(fs, OUT, next, await loadManifest(fs), ['C1']);
    expect(again.actions.filter((a) => a.handEdited)).toEqual([]);
    expect(await undoLast(fs)).toMatchObject({ deleted: 3 }); // the very first sync
    expect(await undoLast(fs)).toBeNull();
  });

  it('never overwrites or removes hand-edited files by default', async () => {
    const fs = new MemoryFS();
    await sync(fs, build({ 'C1 - Course/a.md': text('one\n'), 'C1 - Course/b.md': text('b\n') }));
    fs.set(`${OUT}/C1 - Course/a.md`, 'one\nmy edit\n');
    fs.set(`${OUT}/C1 - Course/b.md`, 'b\nmy edit\n');
    const { plan, log } = await sync(fs, build({ 'C1 - Course/a.md': text('two\n') }), groups({ remove: true }));
    expect(plan.actions.map(groupOf).sort()).toEqual(['overwriteEdited', 'removeEdited']);
    expect(log.modified).toEqual([]);
    expect(log.removed).toEqual([]);
    expect(await read(fs, 'C1 - Course/a.md')).toBe('one\nmy edit\n');
    expect(await read(fs, 'C1 - Course/b.md')).toBe('b\nmy edit\n');
  });

  it('removals default to off and stay inside scanned courses', async () => {
    const fs = new MemoryFS();
    const manifest = emptyManifest();
    manifest.files['Other - Course/x.md'] = { kind: 'text', size: 1, mtime: 1, sha: 'x' };
    manifest.courses.OTHER = { code: 'OTHER', vname: 'Other - Course', entries: 1, files: 0 };
    fs.set('.brightspace-sync/manifest.json', JSON.stringify(manifest));
    fs.set(`${OUT}/Other - Course/x.md`, 'x');
    await sync(fs, build({ 'C1 - Course/a.md': text('one\n') }));
    const { plan, log } = await sync(fs, build({}));
    expect(plan.actions.map((a) => `${a.op}:${a.path}`)).toEqual(['remove:C1 - Course/a.md']);
    expect(log.removed).toEqual([]);
    expect(await read(fs, 'C1 - Course/a.md')).toBe('one\n');
    expect(await read(fs, 'Other - Course/x.md')).toBe('x');
  });

  it('skips files too large to back up and reports failed downloads', async () => {
    const fs = new MemoryFS();
    await sync(fs, build({ 'C1 - Course/big.bin': remote('d1'), 'C1 - Course/ok.md': text('1\n') }), groups(), fetcher('x'.repeat(5000)));
    const { log } = await sync(fs,
      build({ 'C1 - Course/big.bin': remote('d2'), 'C1 - Course/ok.md': text('1\n'), 'C1 - Course/miss.pdf': remote('d1', 2) }),
      groups(), fetcher('gone', 404));
    expect(log.skipped).toEqual([{ path: 'C1 - Course/big.bin', reason: 'too large to back up' }]);
    expect(log.failed).toEqual([{ path: 'C1 - Course/miss.pdf', reason: 'http-404' }]);
    expect((await read(fs, 'C1 - Course/big.bin'))!.length).toBe(5000);
    expect((await loadManifest(fs)).files['C1 - Course/miss.pdf']).toBeUndefined();
  });
});

describe('lineDiff', () => {
  it('shows changes with context', () => {
    const a = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n');
    const b = ['a', 'b', 'c', 'D', 'e', 'f', 'g', 'h', 'i'].join('\n');
    expect(lineDiff(a, b)).toBe(['  b', '  c', '- d', '+ D', '  e', '  f', '  g', '  h', '+ i'].join('\n'));
  });
});
