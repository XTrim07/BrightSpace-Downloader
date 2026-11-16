/** Pure helpers for the popup's tick boxes. */

import type { TreeItem } from './messages';

/** Tickable things under these items. Videos only exist while "Video links" is on. */
export function leafIds(items: TreeItem[], links: boolean, out: string[] = []): string[] {
  for (const it of items) {
    if (it.kind === 'folder') leafIds(it.children || [], links, out);
    else if (it.kind === 'file' || links) out.push(it.id);
  }
  return out;
}

/** How many of the leaves below are ticked: drives checked / indeterminate. */
export function tickState(items: TreeItem[], selected: Set<string>, links: boolean): { on: number; total: number } {
  const ids = leafIds(items, links);
  return { on: ids.filter((id) => selected.has(id)).length, total: ids.length };
}

/**
 * The X in "Download X items" for one course: every folder that has at least
 * one ticked item directly inside it counts as one. Files are not counted.
 */
export function countFolders(items: TreeItem[], selected: Set<string>, links: boolean): number {
  const direct = items.some((it) => it.kind !== 'folder' && (it.kind === 'file' || links) && selected.has(it.id));
  let n = direct ? 1 : 0;
  for (const it of items) {
    if (it.kind === 'folder') n += countFolders(it.children || [], selected, links);
  }
  return n;
}
