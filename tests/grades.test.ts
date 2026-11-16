// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { gradesMd } from '../src/lib/grades';

describe('Grades.md', () => {
  const values = [
    { GradeObjectIdentifier: '1', GradeObjectName: 'Stack', GradeObjectType: 1, PointsNumerator: 11, PointsDenominator: 42, DisplayedGrade: '11 / 42' },
    { GradeObjectIdentifier: '2', GradeObjectName: 'Self Study Week 6', GradeObjectType: 1, PointsNumerator: null, PointsDenominator: 100, DisplayedGrade: '' },
    { GradeObjectIdentifier: '3', GradeObjectName: 'Self Study Week 2 Comment', GradeObjectType: 4, PointsNumerator: null, PointsDenominator: null, DisplayedGrade: '', Comments: { Html: '<p>Well <b>done</b></p>' } },
    { GradeObjectIdentifier: '4', GradeObjectName: 'Midterm', GradeObjectType: 1, PointsNumerator: null, PointsDenominator: 0, DisplayedGrade: '4,8' },
    { GradeObjectIdentifier: '5', GradeObjectName: 'Grand Total', GradeObjectType: 5, PointsNumerator: 3820.5, PointsDenominator: 10000, DisplayedGrade: '3.821 / 10.000' },
    { GradeObjectIdentifier: '10', GradeObjectName: 'Quizzes', GradeObjectType: 9, PointsNumerator: 472, PointsDenominator: 757 },
  ];
  const objects = [
    { Id: 1, CategoryId: 10 }, { Id: 2, CategoryId: 11 }, { Id: 3, CategoryId: 11 },
    { Id: 4, CategoryId: 12 }, { Id: 5, CategoryId: 0 },
  ];
  const categories = [{ Id: 10, Name: 'Quizzes' }, { Id: 11, Name: 'Self Study' }, { Id: 12, Name: 'Exam' }];

  it('follows the Brightspace grades page: categories, points, grade, comments', () => {
    expect(gradesMd('CO', values, objects, categories)).toBe(`# Grades — CO

| Grade Item | Points | Grade | Comments |
| --- | --- | --- | --- |
| Grand Total | 3820.5 / 10000 |  |  |

## Quizzes

| Grade Item | Points | Grade | Comments |
| --- | --- | --- | --- |
| Stack | 11 / 42 |  |  |
| Subtotal | 472 / 757 |  |  |

## Self Study

| Grade Item | Points | Grade | Comments |
| --- | --- | --- | --- |
| Self Study Week 6 | - / 100 |  |  |
| Self Study Week 2 Comment |  |  | Well **done** |

## Exam

| Grade Item | Points | Grade | Comments |
| --- | --- | --- | --- |
| Midterm |  | 4,8 |  |
`);
  });

  it('falls back to one table without category information', () => {
    const md = gradesMd('CO', values);
    expect(md.split('\n').filter((l) => l.startsWith('## '))).toEqual(['## Quizzes']);
    expect(md).toContain('| Stack | 11 / 42 |  |  |');
    expect(gradesMd('CO', [])).toBe('');
    expect(gradesMd('CO', null)).toBe('');
  });
});
