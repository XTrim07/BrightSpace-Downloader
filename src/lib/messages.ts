/** Messages between the popup and the content script running on Brightspace. */

/** One row of the popup tree below a course. */
export interface TreeItem {
  /** folder: module id · file/video: topic id (what gets ticked) */
  id: string;
  kind: 'folder' | 'file' | 'video';
  title: string;
  /** file extension, shown as a small tag */
  tag?: string;
  children?: TreeItem[];
}

export interface CourseInfo {
  id: number;
  name: string;
  active: boolean;
}

export interface Job {
  state: 'idle' | 'running' | 'done' | 'error' | 'cancelled';
  done: number;
  total: number;
  message: string;
}

export interface DownloadRequest {
  /** video links: a Links.md per chapter */
  links: boolean;
  announcements: boolean;
  grades: boolean;
  courses: { courseId: number; selected: string[] }[];
}

export type Request =
  | { type: 'courses' }
  | { type: 'scan'; courseId: number; force?: boolean }
  | { type: 'download'; request: DownloadRequest }
  | { type: 'cancel' }
  | { type: 'status' };

export interface CoursesReply {
  loggedIn: boolean;
  user: string;
  courses: CourseInfo[];
  /** course of the page the tab is showing, if any */
  currentId: number | null;
}

export interface ScanReply {
  items: TreeItem[];
  warnings: string[];
}

export type Reply<T> = { ok: true; data: T } | { ok: false; error: string; auth?: boolean };
