/**
 * Grades.md, laid out like the Brightspace "Grades" page: one section per
 * category, columns Grade Item / Points / Grade / Comments.
 */

import { htmlToMd } from './htmlmd';
import { label } from './util';

function num(n: unknown): string {
  if (n === null || n === undefined || n === '') return '-';
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

function flat(value: unknown): string {
  let v: any = value;
  if (v && typeof v === 'object') v = v.Html || v.Text || '';
  const s = String(v ?? '');
  return (s.includes('<') ? htmlToMd(s) : s).replace(/\s+/g, ' ').trim();
}

const CATEGORY_TYPE = 9;

interface Row {
  name: string;
  points: string;
  grade: string;
  comments: string;
}

/**
 * values: /grades/values/myGradeValues/ · objects: /grades/ ·
 * categories: /grades/categories/. The last two only add the grouping;
 * without them the result is one flat table.
 */
export function gradesMd(courseName: string, values: unknown, objects?: unknown, categories?: unknown): string {
  const items: any[] = Array.isArray(values) ? values : ((values as any)?.Items ?? (values as any)?.Values ?? []);
  if (!Array.isArray(items) || !items.length) return '';

  const categoryName = new Map<string, string>();
  for (const c of Array.isArray(categories) ? categories : []) {
    if (c?.Id != null) categoryName.set(String(c.Id), String(c.Name ?? ''));
  }
  const categoryOf = new Map<string, string>();
  for (const o of Array.isArray(objects) ? objects : []) {
    if (o?.Id != null && o.CategoryId) categoryOf.set(String(o.Id), String(o.CategoryId));
  }

  const groups = new Map<string, Row[]>();
  const push = (group: string, row: Row) => {
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(row);
  };
  for (const g of items) {
    if (!g || typeof g !== 'object') continue;
    const id = String(g.GradeObjectIdentifier ?? '');
    const den = g.PointsDenominator;
    const hasDen = den !== null && den !== undefined && den !== '' && Number(den) !== 0;
    const points = hasDen ? `${num(g.PointsNumerator)} / ${num(den)}` : '';
    let grade = String(g.DisplayedGrade ?? '').trim();
    // The site leaves "Grade" empty when it would only repeat the points.
    if (/^[-\d.,\s]+\/[\d.,\s]+$/.test(grade)) grade = '';
    const row: Row = {
      name: String(g.GradeObjectName ?? g.Name ?? ''),
      points,
      grade,
      comments: flat(g.Comments ?? g.Feedback).slice(0, 500),
    };
    if (Number(g.GradeObjectType) === CATEGORY_TYPE) {
      // A category's own value is its subtotal.
      push(categoryName.get(id) ?? row.name, { ...row, name: 'Subtotal' });
    } else {
      push(categoryName.get(categoryOf.get(id) ?? '') ?? '', row);
    }
  }

  const out = [`# Grades — ${courseName}`];
  // Items outside any category first, then categories in Brightspace order.
  const order = [...groups.keys()].sort((a, b) => Number(a !== '') - Number(b !== ''));
  for (const group of order) {
    const rows = groups.get(group)!;
    out.push('');
    if (group) out.push(`## ${group}`, '');
    out.push('| Grade Item | Points | Grade | Comments |', '| --- | --- | --- | --- |');
    for (const r of rows) {
      out.push(`| ${label(r.name)} | ${r.points} | ${label(r.grade)} | ${label(r.comments)} |`);
    }
  }
  return out.join('\n') + '\n';
}
