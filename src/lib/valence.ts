/**
 * Thin read-only client for the Brightspace Valence API. Uses the browser's
 * existing Brightspace session (cookies); never sees credentials.
 * Deliberately throttled: one request start per MIN_GAP_MS.
 */

import type { Course } from './model';

export const BASE = 'https://brightspace.tudelft.nl';
export const LP_VER = '1.43';
export const LE_VER = '1.75';
const MIN_GAP_MS = 250;

export class AuthExpiredError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Api {
  get<T = any>(path: string): Promise<T | null>;
  fetchFile(courseId: number, topicId: number | string): Promise<Response>;
}

export class ValenceClient implements Api {
  private gate: Promise<void> = Promise.resolve();
  requests = 0;
  /** When set and aborted, running and future requests stop at once (Cancel). */
  signal?: AbortSignal;

  constructor(
    private fetchFn: typeof fetch = (...a) => fetch(...a),
    private gapMs = MIN_GAP_MS,
  ) {}

  /** Throttled fetch with retry on 429/5xx and network errors. */
  async raw(url: string): Promise<Response> {
    let lastErr: unknown;
    const aborted = () => new DOMException('Cancelled', 'AbortError');
    for (let attempt = 0; attempt < 4; attempt++) {
      if (this.signal?.aborted) throw aborted();
      const turn = this.gate;
      let release!: () => void;
      this.gate = new Promise((r) => (release = r));
      await turn;
      setTimeout(release, this.gapMs);
      this.requests++;
      try {
        if (this.signal?.aborted) throw aborted();
        const res = await this.fetchFn(url, { credentials: 'include', redirect: 'follow', signal: this.signal });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`HTTP ${res.status}`);
          await res.body?.cancel().catch(() => {});
          const retryAfter = Number(res.headers.get('retry-after')) || 0;
          await sleep(Math.max(retryAfter * 1000, this.gapMs * 8 * (attempt + 1)));
          continue;
        }
        return res;
      } catch (ex) {
        if (ex instanceof AuthExpiredError || this.signal?.aborted) throw ex;
        lastErr = ex;
        await sleep(this.gapMs * 8 * (attempt + 1));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** GET a Valence path as JSON; 404 -> null, 401 / login page -> AuthExpiredError. */
  async get<T = any>(path: string): Promise<T | null> {
    const res = await this.raw(BASE + path);
    if (res.status === 401) throw new AuthExpiredError(`Not logged in (401 on ${path})`);
    // 403 = this one resource is off limits (hidden module, disabled tool), not a dead session.
    if (res.status === 403) throw new Error(`forbidden (403) ${path}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AuthExpiredError(`Unexpected non-JSON answer for ${path} — are you logged in?`);
    }
  }

  fetchFile(courseId: number, topicId: number | string): Promise<Response> {
    return this.raw(
      `${BASE}/d2l/api/le/${LE_VER}/${courseId}/content/topics/${topicId}/file?stream=false`,
    );
  }
}

export async function whoami(api: Api): Promise<{ name: string; uniqueName: string } | null> {
  const me = await api.get(`/d2l/api/lp/${LP_VER}/users/whoami`);
  if (!me) return null;
  return {
    name: `${me.FirstName ?? ''} ${me.LastName ?? ''}`.trim(),
    uniqueName: me.UniqueName ?? '',
  };
}

/** Course offerings the user is enrolled in (all pages). */
export async function enrollments(api: Api): Promise<Course[]> {
  const courses: Course[] = [];
  let bookmark = '';
  for (let page = 0; page < 50; page++) {
    const q = bookmark ? `?bookmark=${encodeURIComponent(bookmark)}` : '';
    const data = await api.get(`/d2l/api/lp/${LP_VER}/enrollments/myenrollments/${q}`);
    const items: any[] = Array.isArray(data) ? data : (data?.Items ?? []);
    for (const entry of items) {
      const org = entry?.OrgUnit ?? {};
      if (org?.Type?.Name !== 'Course Offering') continue;
      const access = entry?.Access ?? {};
      courses.push({
        id: org.Id,
        code: org.Code ?? '',
        name: org.Name ?? '',
        start: org.StartDate ?? access.StartDate ?? null,
        end: org.EndDate ?? access.EndDate ?? null,
        active: access.IsActive !== false && access.CanAccess !== false,
      });
    }
    const paging = Array.isArray(data) ? null : data?.PagingInfo;
    if (!paging?.HasMoreItems || !paging.Bookmark || paging.Bookmark === bookmark) break;
    bookmark = paging.Bookmark;
  }
  return courses;
}
