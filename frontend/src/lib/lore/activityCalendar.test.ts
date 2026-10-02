import { test, expect } from 'bun:test';
import { revisionCalendar } from './activityCalendar';
test('counts real revisions across legacy timestamp units and ignores invalid dates', () => {
 const time = Date.parse('2026-09-30T12:00:00Z');
 const days = revisionCalendar([{timestamp:time/1000},{timestamp:time},{timestamp:time*1000},{timestamp:NaN}], new Date('2026-10-01T12:00:00Z'));
 expect(days.find(day=>day.date==='2026-09-30')?.count).toBe(3);
 expect(days.at(-1)).toEqual({date:'2026-10-01',count:0});
 expect(days.reduce((sum,day)=>sum+day.count,0)).toBe(3);
});
