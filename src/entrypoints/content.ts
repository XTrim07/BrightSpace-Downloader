/**
 * Runs inside the Brightspace tab. It does all the work (reading the course
 * structure, fetching files, building the .zip) so a download keeps going
 * after the popup closes. Requests are same-origin, with the page's session.
 */

import { downloadZip } from 'client-zip';
import { browser } from 'wxt/browser';
import type {
  CoursesReply, DownloadRequest, Job, Reply, Request, ScanReply, TreeItem,
} from '@/lib/messages';
import type { Course, ScannedCourse, TreeNode } from '@/lib/model';
import { loadExtras, scanCourse } from '@/lib/scan';
import { AuthExpiredError, enrollments, ValenceClient, whoami } from '@/lib/valence';
import {
  countSelectedFiles, courseFolder, exportEntries, isFile, isVideo,
  type ExportReport, type ZipEntry,
} from '@/lib/zipexport';

export default defineContentScript({
  matches: ['https://brightspace.tudelft.nl/*'],
  main() {
    // The popup may inject this script again into a tab opened before install.
    if ((window as any).__bvsLoaded) return;
    (window as any).__bvsLoaded = true;

    const api = new ValenceClient();
    let courses: Course[] = [];
    const scans = new Map<number, ScannedCourse>();
    let job: Job = { state: 'idle', done: 0, total: 0, message: '' };
    /** Cancel button: aborts running requests and ends the job at once. */
    let abort: AbortController | null = null;
    let cancelled = false;
    class Cancelled extends Error {}

    function currentCourseId(): number | null {
      const m =
        location.pathname.match(/\/d2l\/(?:home|le\/lessons|le\/content|le\/calendar|lms\/\w+)\/(\d+)/) ||
        location.search.match(/[?&]ou=(\d+)/);
      return m ? Number(m[1]) : null;
    }

    async function getCourses(): Promise<CoursesReply> {
      const me = await whoami(api);
      if (!me) return { loggedIn: false, user: '', courses: [], currentId: null };
      if (!courses.length) courses = await enrollments(api);
      return {
        loggedIn: true,
        user: me.name || me.uniqueName,
        courses: courses.map((c) => ({ id: c.id, name: c.name, active: c.active !== false })),
        currentId: currentCourseId(),
      };
    }

    /** Folders plus the things one can tick inside them: files and videos. */
    function items(nodes: TreeNode[]): TreeItem[] {
      const out: TreeItem[] = [];
      for (const n of nodes) {
        if (n.kind === 'module') {
          out.push({ id: String(n.id), kind: 'folder', title: n.title, children: items(n.children || []) });
        } else if (isVideo(n)) {
          out.push({ id: String(n.id), kind: 'video', title: n.title });
        } else if (isFile(n)) {
          const dot = (n.name || '').lastIndexOf('.');
          out.push({
            id: String(n.id), kind: 'file', title: n.title,
            tag: dot > 0 ? n.name!.slice(dot + 1).toLowerCase() : undefined,
          });
        }
      }
      return out;
    }

    async function ensureScan(courseId: number, force = false): Promise<ScannedCourse> {
      let sc = scans.get(courseId);
      if (!sc || force) {
        if (!courses.length) courses = await enrollments(api);
        const course = courses.find((c) => c.id === courseId)
          ?? { id: courseId, code: `course-${courseId}`, name: `Course ${courseId}` };
        sc = await scanCourse(api, course, { names: {}, descs: {} }, () => {}, { fast: true });
        scans.set(courseId, sc);
      }
      return sc;
    }

    async function scan(courseId: number, force = false): Promise<ScanReply> {
      const sc = await ensureScan(courseId, force);
      return { items: items(sc.tree), warnings: sc.errors };
    }

    // ---- progress: a small box in the page corner + messages to the popup

    let box: HTMLElement | null = null;
    function report(next: Partial<Job>): void {
      job = { ...job, ...next };
      browser.runtime.sendMessage({ type: 'progress', job }).catch(() => {});
      if (!box) {
        box = document.createElement('div');
        box.style.cssText =
          'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:320px;padding:10px 14px;' +
          'border-radius:10px;background:#1c1c20;color:#f2f2f5;font:13px/1.4 system-ui,sans-serif;' +
          'box-shadow:0 4px 16px rgba(0,0,0,.35);border:1px solid #2563eb;cursor:pointer';
        box.title = 'Click to dismiss';
        box.addEventListener('click', () => {
          if (job.state !== 'running') box?.remove(), (box = null);
        });
        document.body.append(box);
      }
      box.textContent = `BrightSpace Downloader: ${job.message}`;
    }

    async function download(req: DownloadRequest): Promise<void> {
      cancelled = false;
      const ctl = (abort = new AbortController());
      api.signal = ctl.signal;
      // Rejects the moment Cancel is pressed, whatever the download is busy with.
      const stop = new Promise<never>((_, reject) => {
        ctl.signal.addEventListener('abort', () => reject(new Cancelled()));
      });
      stop.catch(() => {});
      report({ state: 'running', done: 0, total: 0, message: 'Reading courses…' });
      try {
        await Promise.race([run(), stop]);
      } catch (ex) {
        if (ex instanceof Cancelled || cancelled) {
          report({ state: 'cancelled', message: 'Download cancelled.' });
        } else {
          report({
            state: 'error',
            message: ex instanceof AuthExpiredError
              ? 'Session expired — log in to BrightSpace again.'
              : `Failed: ${(ex as Error).message || ex}`,
          });
        }
      } finally {
        if (api.signal === ctl.signal) api.signal = undefined;
        if (abort === ctl) abort = null;
      }

      async function run(): Promise<void> {
        const parts: { sc: ScannedCourse; selected: Set<string> }[] = [];
        for (const c of req.courses) {
          if (ctl.signal.aborted) throw new Cancelled();
          const sc = await ensureScan(c.courseId);
          await loadExtras(api, sc, req);
          parts.push({ sc, selected: new Set(c.selected) });
        }
        const total = parts.reduce((n, p) => n + countSelectedFiles(p.sc.tree, p.selected), 0);
        const result: ExportReport = { files: 0, links: 0, failed: [] };
        let base = 0;
        async function* all(): AsyncGenerator<ZipEntry> {
          for (const p of parts) {
            const mine = countSelectedFiles(p.sc.tree, p.selected);
            yield* exportEntries(p.sc, { ...req, selected: p.selected }, api, result, (done, _t, name) => {
              if (ctl.signal.aborted) throw new Cancelled();
              report({ done: base + done, total, message: name ? `${base + done + 1}/${total} · ${name}` : 'Packing…' });
            });
            base += mine;
          }
        }
        const blob = await downloadZip(all() as AsyncIterable<any>).blob();
        if (ctl.signal.aborted) throw new Cancelled();
        const name = parts.length === 1
          ? courseFolder(parts[0].sc)
          : `BrightSpace ${new Date().toISOString().slice(0, 10)}`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${name}.zip`;
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        report({
          state: 'done', done: total, total,
          message: `Done — ${result.files} files, ${result.links} video links` +
            (result.failed.length ? `, ${result.failed.length} failed (listed in the zip)` : ''),
        });
      }
    }

    window.addEventListener('beforeunload', (e) => {
      if (job.state === 'running') e.preventDefault();
    });

    async function handle(msg: Request): Promise<unknown> {
      switch (msg.type) {
        case 'courses':
          return getCourses();
        case 'scan':
          return scan(msg.courseId, msg.force);
        case 'status':
          return job;
        case 'cancel':
          if (job.state === 'running') {
            cancelled = true;
            abort?.abort();
            report({ state: 'cancelled', message: 'Download cancelled.' });
          }
          return job;
        case 'download':
          if (job.state === 'running') throw new Error('A download is already running in this tab.');
          void download(msg.request);
          return job;
      }
    }

    browser.runtime.onMessage.addListener((msg: Request, _sender, sendResponse) => {
      if (!msg || !['courses', 'scan', 'status', 'download', 'cancel'].includes(msg.type)) return;
      handle(msg).then(
        (data) => sendResponse({ ok: true, data } satisfies Reply<unknown>),
        (ex) => sendResponse({
          ok: false,
          error: (ex as Error).message || String(ex),
          auth: ex instanceof AuthExpiredError,
        } satisfies Reply<unknown>),
      );
      return true; // answer asynchronously
    });
  },
});
