/**
 * Scan one course: Valence content tree -> TreeNode model (metadata only, no
 * file downloads). Port of bsvault/sync.py + snapshots.py. Children always
 * stay in API (= Brightspace) order — never sorted.
 */

import { htmlToMd } from './htmlmd';
import type { Course, ScannedCourse, TreeNode } from './model';
import { walkTree } from './model';
import { sanitize } from './util';
import { type Api, AuthExpiredError, LE_VER } from './valence';

/** Persisted between runs so names stay stable and descriptions are not refetched. */
export interface ScanState {
  /** owner key -> claimed file/dir name */
  names: Record<string, string>;
  /** `${owner}@${lastModified}` -> description markdown */
  descs: Record<string, string>;
}

export const TEXT_CAP = 100000;
const TEXT_EXTS = new Set(['.txt', '.md', '.csv', '.s', '.py', '.c', '.h', '.java', '.vim']);
const HYDRATE_MAX_BYTES = 5 * 1024 * 1024;

/** Internal quicklinks and javascript: targets only work inside Brightspace. */
export function isDeadUrlTarget(url: string | null | undefined): boolean {
  const u = (url || '').trim();
  return !u || u.startsWith('/d2l/') || u.startsWith('javascript:');
}

function descOf(obj: any): string {
  const desc = obj?.Description || {};
  const html: string = desc.Html || '';
  if (html && html.includes('<')) {
    try {
      return htmlToMd(html).trim();
    } catch {
      /* fall through to plain text */
    }
  }
  return String(desc.Text || '').trim();
}

/** Stable unique name within one directory; a known owner keeps its previous name. */
export function claim(
  stem: string,
  suffix: string,
  owner: string,
  names: Record<string, string>,
  taken: Set<string>,
): string {
  const prev = names[owner];
  let cand = `${stem}${suffix}`;
  if (prev && prev.toLowerCase().endsWith(suffix.toLowerCase()) && !taken.has(prev.toLowerCase())) {
    cand = prev;
  } else {
    for (let i = 2; taken.has(cand.toLowerCase()); i++) cand = `${stem} (${i})${suffix}`;
  }
  taken.add(cand.toLowerCase());
  names[owner] = cand;
  return cand;
}

function urlExt(url: string): string {
  const clean = url.split('?')[0];
  const base = clean.slice(clean.lastIndexOf('/') + 1);
  const i = base.lastIndexOf('.');
  const ext = i > 0 ? base.slice(i) : '';
  return ext.length > 6 ? '' : ext;
}

/**
 * The table-of-contents endpoint returns the whole course in one request.
 * Reshape it into the node format the walker understands, with children
 * attached as `_kids` (modules and topics merged back into display order).
 */
export function normalizeToc(modules: any[]): any[] {
  return (modules || []).map((m) => {
    const kids = [
      ...normalizeToc(m.Modules || []).map((n, i) => ({ n, order: m.Modules[i]?.SortOrder })),
      ...(m.Topics || []).map((t: any) => ({
        order: t.SortOrder,
        n: {
          Id: t.TopicId ?? t.Id,
          Title: t.Title,
          Type: 1,
          TopicType: t.TypeIdentifier === 'File' || String(t.Url || '').startsWith('/content/') ? 1 : 3,
          Url: t.Url,
          LastModifiedDate: t.LastModifiedDate,
          Description: t.Description,
        },
      })),
    ];
    if (kids.every((k) => typeof k.order === 'number')) kids.sort((a, b) => a.order - b.order);
    return {
      Id: m.ModuleId ?? m.Id,
      Title: m.Title,
      Type: 0,
      LastModifiedDate: m.LastModifiedDate,
      Description: m.Description,
      _kids: kids.map((k) => k.n),
    };
  });
}

class Scanner {
  errors: string[] = [];

  constructor(
    private api: Api,
    private cid: number,
    private state: ScanState,
    private onProgress: (msg: string) => void,
    /** fast: no per-item requests (descriptions, content sniffing) */
    private fast = false,
  ) {}

  private async safeGet(path: string, what: string): Promise<any> {
    try {
      return await this.api.get(path);
    } catch (ex) {
      if (ex instanceof AuthExpiredError) throw ex;
      this.errors.push(`${what}: ${(ex as Error).message}`);
      return null;
    }
  }

  private async desc(kind: 'modules' | 'topics', node: any, owner: string): Promise<string> {
    const emb = node.Description || {};
    if (emb.Html || emb.Text) return descOf(node);
    if (this.fast) return '';
    const key = `${owner}@${node.LastModifiedDate || ''}`;
    if (key in this.state.descs) return this.state.descs[key];
    const full = await this.safeGet(
      `/d2l/api/le/${LE_VER}/${this.cid}/content/${kind}/${node.Id}`,
      `${kind}/${node.Id}`,
    );
    const d = descOf(full);
    if (full) this.state.descs[key] = d;
    return d;
  }

  async walk(nodes: any[], dir: string, out: TreeNode[]): Promise<void> {
    const taken = new Set<string>();
    for (const node of nodes) {
      const rawTitle: string = node.Title || 'untitled';
      const title = sanitize(rawTitle);
      const kids = node.Modules?.length ? node.Modules : node.Topics;
      const isMod = (node.Type === 0 && node.TopicType == null) || Array.isArray(kids);
      if (isMod && node.Id && node.TopicType == null && !node.Url) {
        await this.walkModule(node, title, rawTitle, dir, out, taken);
      } else {
        await this.walkTopic(node, title, rawTitle, dir, out, taken);
      }
    }
  }

  private async walkModule(
    node: any, title: string, rawTitle: string, dir: string, out: TreeNode[], taken: Set<string>,
  ): Promise<void> {
    const owner = `${this.cid}:mod:${node.Id}`;
    this.onProgress(rawTitle);
    const desc = await this.desc('modules', node, owner);
    const name = claim(title, '', owner, this.state.names, taken);
    let children: any[];
    if (Array.isArray(node._kids)) {
      children = node._kids;
    } else {
      const structure = await this.safeGet(
        `/d2l/api/le/${LE_VER}/${this.cid}/content/modules/${node.Id}/structure/`,
        `structure ${node.Id}`,
      );
      children =
        (Array.isArray(structure) && structure.length ? structure : null) ||
        (node.Modules?.length ? node.Modules : null) ||
        node.Topics ||
        [];
    }
    const sub: TreeNode[] = [];
    await this.walk(children, dir ? `${dir}/${name}` : name, sub);
    out.push({
      kind: 'module', id: node.Id, title: rawTitle, name, desc,
      lastModified: String(node.LastModifiedDate || ''), children: sub,
    });
  }

  private async walkTopic(
    node: any, title: string, rawTitle: string, dir: string, out: TreeNode[], taken: Set<string>,
  ): Promise<void> {
    const tid = node.Id;
    if (tid == null) return;
    const url: string = node.Url || '';
    const owner = `${this.cid}:${tid}`;
    const lastModified = String(node.LastModifiedDate || '');
    if (url && !url.startsWith('/content/') && node.TopicType !== 1) {
      if (isDeadUrlTarget(url)) {
        out.push({
          kind: 'locked', id: tid, title: rawTitle, desc: '', lastModified, url,
          reason: 'Only opens inside Brightspace.',
        });
        return;
      }
      const desc = await this.desc('topics', node, owner);
      out.push({ kind: 'link', id: tid, title: rawTitle, url, desc, lastModified });
      return;
    }
    const ext = urlExt(url);
    const desc = await this.desc('topics', node, owner);
    let name = claim(title, ext, owner, this.state.names, taken);
    let kind: 'file' | 'page' = name.toLowerCase().endsWith('.html') ? 'page' : 'file';
    let text: string | undefined;
    if (!this.fast && !ext && !name.toLowerCase().endsWith('.html')) {
      // No extension in the URL: peek at the content type to spot HTML pages.
      try {
        const res = await this.api.fetchFile(this.cid, tid);
        if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
          text = await res.text();
          taken.delete(name.toLowerCase());
          name = claim(title, '.html', `${owner}:html`, this.state.names, taken);
          kind = 'page';
        } else {
          await res.body?.cancel().catch(() => {});
          if (!res.ok) {
            out.push({
              kind: 'locked', id: tid, title: rawTitle, desc: '', lastModified,
              reason: `Download failed (http-${res.status}).`,
            });
            return;
          }
        }
      } catch (ex) {
        if (ex instanceof AuthExpiredError) throw ex;
        this.errors.push(`sniff ${tid}: ${(ex as Error).message}`);
      }
    }
    out.push({
      kind, id: tid, title: rawTitle, name, path: dir ? `${dir}/${name}` : name,
      desc, url, lastModified, text,
    });
  }
}

function announcementsDigest(code: string, courseName: string, news: any): string | null {
  const items: any[] = Array.isArray(news) ? news : (news?.Items ?? []);
  if (!items.length) return null;
  const lines = [`# Announcements - ${code} ${courseName}`];
  for (const item of items) {
    const body = item?.Body;
    const src = body && typeof body === 'object' ? body.Html || body.Text || '' : String(body ?? '');
    lines.push(
      `\n## ${item?.Title ?? ''}\n*${item?.StartDate ?? ''}*\n\n${htmlToMd(src).slice(0, 4000)}\n`,
    );
  }
  return lines.join('\n');
}

export async function scanCourse(
  api: Api,
  course: Course,
  state: ScanState,
  onProgress: (msg: string) => void = () => {},
  opts: { fast?: boolean } = {},
): Promise<ScannedCourse> {
  const code = sanitize(course.code || `course-${course.id}`, 80);
  const scanner = new Scanner(api, course.id, state, onProgress, !!opts.fast);
  const base = `/d2l/api/le/${LE_VER}/${course.id}`;
  let toc: any = null;
  let roots: any[] | null = null;
  if (opts.fast) {
    // One request for the whole tree; fall back to the module-by-module walk.
    try {
      toc = await api.get(`${base}/content/toc`);
      if (Array.isArray(toc?.Modules)) roots = normalizeToc(toc.Modules);
    } catch (ex) {
      if (ex instanceof AuthExpiredError) throw ex;
    }
  }
  if (!roots) {
    toc = (await api.get(`${base}/content/root/`)) || [];
    roots = Array.isArray(toc) ? toc : [];
  }
  const tree: TreeNode[] = [];
  await scanner.walk(roots, '', tree);

  const sc: ScannedCourse = {
    course, code, tree, toc,
    dropbox: null, announcements: null, grades: null,
    errors: scanner.errors,
  };
  // Fast scans read the content tree only; the extras are loaded when a
  // download actually asks for them (see loadExtras).
  if (!opts.fast) {
    onProgress('assignments, announcements, grades');
    await loadExtras(api, sc, { announcements: true, grades: true, dropbox: true });
  }
  return sc;
}

/** Fetch announcements / grades (/ assignments) for a scanned course, once. */
export async function loadExtras(
  api: Api,
  sc: ScannedCourse,
  want: { announcements?: boolean; grades?: boolean; dropbox?: boolean },
): Promise<void> {
  const base = `/d2l/api/le/${LE_VER}/${sc.course.id}`;
  const done = ((sc as any)._extras ??= new Set<string>()) as Set<string>;
  const get = async (path: string, what: string | null) => {
    try {
      return await api.get(path);
    } catch (ex) {
      if (ex instanceof AuthExpiredError) throw ex;
      // Tools a course has switched off answer 403: skip, don't abort.
      if (what) sc.errors.push(`${what} skipped: ${(ex as Error).message}`);
      return null;
    }
  };
  if (want.dropbox && !done.has('dropbox')) {
    const boxes = await get(`${base}/dropbox/folders/`, 'assignments');
    sc.dropbox = Array.isArray(boxes) && boxes.length ? boxes : null;
    done.add('dropbox');
  }
  if (want.announcements && !done.has('news')) {
    const news = await get(`${base}/news/`, 'announcements');
    try {
      sc.announcements = announcementsDigest(sc.code, sc.course.name, news);
    } catch (ex) {
      sc.errors.push(`announcements skipped: ${(ex as Error).message}`);
    }
    done.add('news');
  }
  if (want.grades && !done.has('grades')) {
    const grades = await get(`${base}/grades/values/myGradeValues/`, 'grades');
    const has = Array.isArray(grades) ? grades.length > 0 : !!grades;
    sc.grades = has ? grades : null;
    if (has) {
      // Grouping info for Grades.md; optional, so failures are silent.
      sc.gradeObjects = await get(`${base}/grades/`, null);
      sc.gradeCategories = await get(`${base}/grades/categories/`, null);
    }
    done.add('grades');
  }
}

/**
 * Fetch the small payloads the vault notes are built from: HTML pages and
 * plain-text files. Binary files are never loaded here.
 */
export async function hydrate(
  api: Api,
  courseId: number,
  tree: TreeNode[],
  onProgress: (msg: string) => void = () => {},
): Promise<string[]> {
  const errors: string[] = [];
  for (const node of walkTree(tree)) {
    const name = (node.name || '').toLowerCase();
    const i = name.lastIndexOf('.');
    const isText = node.kind === 'file' && i > 0 && TEXT_EXTS.has(name.slice(i));
    if (!(node.kind === 'page' || isText) || node.text !== undefined) continue;
    onProgress(node.title);
    try {
      const res = await api.fetchFile(courseId, node.id);
      const len = Number(res.headers.get('content-length')) || 0;
      if (!res.ok || len > HYDRATE_MAX_BYTES) {
        await res.body?.cancel().catch(() => {});
        if (!res.ok) errors.push(`${node.title}: http-${res.status}`);
        continue;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      node.text = new TextDecoder('utf-8').decode(bytes);
      if (isText) node.bytes = bytes;
    } catch (ex) {
      if (ex instanceof AuthExpiredError) throw ex;
      errors.push(`${node.title}: ${(ex as Error).message}`);
    }
  }
  return errors;
}
