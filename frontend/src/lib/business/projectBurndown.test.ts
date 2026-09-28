import { test, expect } from 'bun:test';
import { projectBurndown, type BurnRevision } from './projectBurndown';
test('burndown reflects scope changes, reopening, unestimated cards and archive', () => {
 const row = (id: string, rev: number, at: number, status: string, minutes: number | null): BurnRevision => ({taskId:id, revision:rev, updatedAtMicros:at*1000, status, isArchived:status==='archived', humanEstimateMinutes:minutes});
 const points = projectBurndown([row('a',1,1,'todo',120), row('a',2,2,'done',120), row('b',1,3,'todo',null), row('a',3,4,'in_progress',180), row('a',4,5,'archived',180)]);
 expect(points.map(p => [p.remainingMinutes,p.scopeMinutes,p.unestimated])).toEqual([[120,120,0],[0,120,0],[0,120,1],[180,180,1],[0,0,1]]);
 expect(projectBurndown([row('a',2,1,'done',120), row('a',1,2,'todo',120)]).at(-1)?.remainingMinutes).toBe(0);
});
