import { describe, expect, test } from 'bun:test';
import { CALL_ANSWER_TIMEOUT_MS, OutgoingRingDeadline, noAnswerNotice } from './callRinging';

describe('outgoing ring deadline', () => {
	test('reports no answer after a bounded unanswered call', async () => {
		const deadline = new OutgoingRingDeadline();
		let notice = '';
		deadline.arm('call-1', () => { notice = noAnswerNotice('Tim'); }, 1);
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(notice).toBe('No answer from Tim. They may be offline.');
		expect(CALL_ANSWER_TIMEOUT_MS).toBeGreaterThan(10_000);
	});

	test('answer or a newer attempt cancels the old deadline', async () => {
		const deadline = new OutgoingRingDeadline();
		const outcomes: string[] = [];
		deadline.arm('old', () => outcomes.push('old'), 1);
		deadline.arm('new', () => outcomes.push('new'), 1);
		deadline.clear('old');
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(outcomes).toEqual(['new']);
		deadline.arm('answered', () => outcomes.push('answered'), 1);
		deadline.clear('answered');
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(outcomes).toEqual(['new']);
	});

	test('group no-answer wording does not claim offline presence as a fact', () => {
		expect(noAnswerNotice('Project room', true)).toBe('No answer in Project room. Members may be offline.');
	});
});
