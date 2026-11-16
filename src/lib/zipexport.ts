/**
 * Layout of the downloaded .zip. Purely structural: it mirrors how the course
 * is arranged on Brightspace, nothing is interpreted or rewritten.
 *
 *   <Course name>/
 *   ├── Content/
 *   │   └── <Chapter>/
 *   │       ├── <Sub-chapter>/…      original files, same nesting as Brightspace
 *   │       ├── <file>.pdf
 *   │       └── Links.md             only when this chapter has selected videos
 *   ├── Announcements.md             when ticked
 *   └── Grades.md                    when ticked
 *
 * Only the items the user ticked are exported.
 */

import { gradesMd } from './grades';
import type { ScannedCourse, TreeNode } from './model';
import { label, sanitize } from './util';
import { type Api, AuthExpiredError } from './valence';

export interface ExportOptions {
  /** video links: written to a Links.md per chapter */
  links: boolean;
  announcements: boolean;
  grades: boolean;
  /** ids of the ticked topics (files, pages, videos) */
  selected: Set<string>;
}

export interface ZipEntry {
  name: string;
  input: string | Uint8Array | Response;
  lastModified?: Date;
}

export interface ExportReport {
  files: number;
  links: number;
  failed: { path: string; reason: string }[];
}

interface Link {
  title: string;
  url: string;
}

const VIDEO_HOST = /(youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com|kaltura|mediasite|collegerama)/i;
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;

/** A link topic that points at a video (YouTube etc.). */
export function isVideo(node: TreeNode): boolean {
  return node.kind === 'link' && !!node.url && VIDEO_HOST.test(node.url);
}

export function isFile(node: TreeNode): boolean {
  return node.kind === 'file' || node.kind === 'page';
}

/** Turn player/embed addresses into the plain watch link. */
export function plainVideoUrl(url: string): string {
  const u = url.replace(/&amp;/g, '&');
  const yt = u.match(/(?:youtube(?:-nocookie)?\.com\/(?:embed\/|v\/|shorts\/|watch\?(?:.*&)?v=)|youtu\.be\/)([\w-]{6,})/i);
  if (yt) return `https://www.youtube.com/watch?v=${yt[1]}`;
  const vimeo = u.match(/player\.vimeo\.com\/video\/(\d+)/i);
  if (vimeo) return `https://vimeo.com/${vimeo[1]}`;
  return u;
}

/** Video links embedded in a piece of HTML or markdown. */
export function videoLinksIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.match(URL_RE) || []) {
    if (!VIDEO_HOST.test(m)) continue;
    const url = plainVideoUrl(m.replace(/[.,;]+$/, ''));
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

function linksMd(title: string, links: Link[]): string {
  const lines = [`# Video links — ${title}`, ''];
  for (const l of links) lines.push(`- [${label(l.title) || l.url}](${l.url})`);
  return lines.join('\n') + '\n';
}

export function courseFolder(sc: ScannedCourse): string {
  return sanitize(sc.course.name || sc.code, 100);
}

/** Number of files that will be fetched for this selection. */
export function countSelectedFiles(nodes: TreeNode[], selected: Set<string>): number {
  let n = 0;
  for (const node of nodes) {
    if (node.kind === 'module') n += countSelectedFiles(node.children || [], selected);
    else if (isFile(node) && selected.has(String(node.id))) n++;
  }
  return n;
}

export async function* exportEntries(
  sc: ScannedCourse,
  opts: ExportOptions,
  api: Api,
  report: ExportReport,
  onProgress: (done: number, total: number, name: string) => void = () => {},
): AsyncGenerator<ZipEntry> {
  const root = courseFolder(sc);
  const total = countSelectedFiles(sc.tree, opts.selected);
  let done = 0;

  /** The ticked items directly inside one chapter folder, then its sub-chapters. */
  async function* level(nodes: TreeNode[], dir: string, title: string, desc: string): AsyncGenerator<ZipEntry> {
    const links: Link[] = [];
    const addLink = (linkTitle: string, url: string) => {
      if (!links.some((l) => l.url === url)) links.push({ title: linkTitle, url });
    };
    let any = false;
    for (const node of nodes) {
      if (node.kind === 'module' || !opts.selected.has(String(node.id))) continue;
      if (isVideo(node)) {
        if (opts.links) {
          addLink(node.title, plainVideoUrl(node.url!));
          any = true;
        }
        continue;
      }
      if (!isFile(node)) continue;
      any = true;
      if (opts.links) for (const url of videoLinksIn(node.desc || '')) addLink(node.title, url);
      let path = `${dir}/${node.name}`;
      onProgress(done++, total, node.title);
      try {
        const res = await api.fetchFile(sc.course.id, node.id);
        if (!res.ok || !res.body) {
          await res.body?.cancel().catch(() => {});
          report.failed.push({ path, reason: `http-${res.status}` });
          continue;
        }
        const stamp = node.lastModified ? new Date(node.lastModified) : undefined;
        const lastModified = stamp && !Number.isNaN(stamp.getTime()) ? stamp : undefined;
        const isHtml = (res.headers.get('content-type') || '').includes('text/html');
        report.files++;
        if (isHtml) {
          // Content pages are small: read them to pick up embedded videos.
          const bytes = new Uint8Array(await res.arrayBuffer());
          if (opts.links) {
            for (const url of videoLinksIn(new TextDecoder().decode(bytes))) addLink(node.title, url);
          }
          if (!/\.html?$/i.test(path)) path += '.html';
          yield { name: path, input: bytes, lastModified };
        } else {
          yield { name: path, input: new Response(res.body), lastModified };
        }
      } catch (ex) {
        if (ex instanceof AuthExpiredError) throw ex;
        report.failed.push({ path, reason: (ex as Error).message || String(ex) });
      }
    }
    if (opts.links && any) {
      // Videos embedded in the chapter's own description come first.
      const all: Link[] = [];
      for (const l of [...videoLinksIn(desc).map((url) => ({ title, url })), ...links]) {
        if (!all.some((x) => x.url === l.url)) all.push(l);
      }
      if (all.length) {
        report.links += all.length;
        yield { name: `${dir}/Links.md`, input: linksMd(title, all) };
      }
    }
    for (const node of nodes) {
      if (node.kind !== 'module') continue;
      yield* level(node.children || [], `${dir}/${node.name}`, node.title, node.desc || '');
    }
  }

  const failedBefore = report.failed.length;
  yield* level(sc.tree, `${root}/Content`, sc.course.name, '');
  onProgress(total, total, '');

  if (opts.announcements && sc.announcements) {
    const body = sc.announcements.replace(/^# .*\n?/, '');
    yield { name: `${root}/Announcements.md`, input: `# Announcements — ${sc.course.name}\n${body}` };
  }
  if (opts.grades) {
    const md = gradesMd(sc.course.name, sc.grades, sc.gradeObjects, sc.gradeCategories);
    if (md) yield { name: `${root}/Grades.md`, input: md };
  }
  const failed = report.failed.slice(failedBefore);
  if (failed.length) {
    yield {
      name: `${root}/Failed downloads.txt`,
      input: failed.map((f) => `${f.path}\t${f.reason}`).join('\n') + '\n',
    };
  }
}
