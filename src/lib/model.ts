/** Shared types. The tree shape mirrors the Python pipeline's moc.json. */

export interface Course {
  id: number;
  code: string;
  name: string;
  start?: string | null;
  end?: string | null;
  active?: boolean;
}

export type NodeKind = 'module' | 'file' | 'page' | 'link' | 'locked';

export interface TreeNode {
  kind: NodeKind;
  id: number | string;
  title: string;
  desc: string;
  /** module: directory name; file/page: file name */
  name?: string;
  /** file/page: path relative to the course folder (forward slashes) */
  path?: string;
  url?: string;
  reason?: string;
  lastModified?: string;
  children?: TreeNode[];
  /** hydrated on demand: page HTML or text-file contents */
  text?: string;
  bytes?: Uint8Array;
}

export interface ScannedCourse {
  course: Course;
  /** sanitized course code: folder name in the raw export, manifest key */
  code: string;
  tree: TreeNode[];
  toc: unknown;
  dropbox: Record<string, unknown>[] | null;
  /** raw digest, same format as the Python `_announcements.md` */
  announcements: string | null;
  grades: unknown | null;
  /** grade items and categories: only used to group Grades.md */
  gradeObjects?: unknown;
  gradeCategories?: unknown;
  errors: string[];
}

export type Category = 'documents' | 'videos' | 'pages' | 'links' | 'other';

export interface Selection {
  categories: Record<Category, boolean>;
  announcements: boolean;
  assignments: boolean;
  grades: boolean;
  /** `${courseId}:${nodeId}` keys the user unticked in the tree */
  excluded: Set<string>;
  /** 0 = no limit */
  maxFileMB: number;
}

const DOC_EXTS = new Set([
  '.pdf', '.ppt', '.pptx', '.pps', '.ppsx', '.doc', '.docx', '.xls', '.xlsx',
  '.odt', '.odp', '.ods', '.key', '.pages', '.numbers', '.txt', '.md', '.rtf',
  '.csv', '.tex', '.epub',
]);
const VIDEO_EXTS = new Set([
  '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.wmv', '.flv', '.mpg',
  '.mpeg', '.mp3', '.m4a', '.wav',
]);

export function categoryOf(node: TreeNode): Category | null {
  if (node.kind === 'link') return 'links';
  if (node.kind === 'page') return 'pages';
  if (node.kind !== 'file') return null;
  const name = node.name || '';
  const i = name.lastIndexOf('.');
  const ext = i > 0 ? name.slice(i).toLowerCase() : '';
  if (VIDEO_EXTS.has(ext)) return 'videos';
  if (DOC_EXTS.has(ext)) return 'documents';
  return 'other';
}

export function nodeKey(courseId: number, node: TreeNode): string {
  return `${courseId}:${node.kind === 'module' ? 'm' : 't'}${node.id}`;
}

/** Copy of the tree with unselected leaves removed. Modules and locked entries stay. */
export function filterTree(courseId: number, nodes: TreeNode[], sel: Selection): TreeNode[] {
  const out: TreeNode[] = [];
  for (const node of nodes) {
    if (sel.excluded.has(nodeKey(courseId, node))) continue;
    if (node.kind === 'module') {
      out.push({ ...node, children: filterTree(courseId, node.children || [], sel) });
      continue;
    }
    const cat = categoryOf(node);
    if (cat && !sel.categories[cat]) continue;
    out.push(node);
  }
  return out;
}

export function* walkTree(nodes: TreeNode[]): Generator<TreeNode> {
  for (const node of nodes) {
    yield node;
    if (node.children) yield* walkTree(node.children);
  }
}

/** moc.json-compatible copy: no hydrated payloads. */
export function plainTree(nodes: TreeNode[]): TreeNode[] {
  return nodes.map(({ text: _t, bytes: _b, children, ...rest }) =>
    children ? { ...rest, children: plainTree(children) } : rest,
  );
}
