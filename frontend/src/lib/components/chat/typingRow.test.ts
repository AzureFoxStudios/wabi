import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createTypingAnnouncer, typingSegments } from './typingRow';

// Contract: design spec §7.17 (typing row) and §10 (live regions: typing is polite, throttled).

const EN: Record<string, string> = {
	'chat.typing.one': '{user} is writing',
	'chat.typing.two': '{user1} and {user2} are writing',
	'chat.typing.many': 'Several people are writing',
	'chat.typing.multi': 'Several people are writing'
};
const t = (key: string, options?: { values?: Record<string, string> }) =>
	(EN[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => options?.values?.[name] ?? '');

describe('typingSegments', () => {
	test('"Iris is writing", with the name marked', () => {
		expect(typingSegments(['Iris Wong'], t)).toEqual([{ text: 'Iris Wong', name: true }, { text: ' is writing' }]);
	});

	test('"Iris and Leo are writing"', () => {
		expect(typingSegments(['Iris', 'Leo'], t)).toEqual([
			{ text: 'Iris', name: true },
			{ text: ' and ' },
			{ text: 'Leo', name: true },
			{ text: ' are writing' }
		]);
	});

	test('three or more: "Several people are writing"; nobody: nothing', () => {
		expect(typingSegments(['A', 'B', 'C'], t)).toEqual([{ text: 'Several people are writing' }]);
		expect(typingSegments([], t)).toEqual([]);
		expect(typingSegments([''], t)).toEqual([]);
	});

	test('a language that puts the name last keeps its order', () => {
		const late = (key: string, options?: { values?: Record<string, string> }) => (key === 'chat.typing.one' ? `Escribiendo: ${options?.values?.user}` : key);
		expect(typingSegments(['Iris'], late)).toEqual([{ text: 'Escribiendo: ' }, { text: 'Iris', name: true }]);
	});
});

describe('createTypingAnnouncer (one polite announcement per 10 s)', () => {
	function harness() {
		let clock = 0;
		const timers: { at: number; run: () => void; id: number }[] = [];
		let nextId = 1;
		const spoken: string[] = [];
		const announcer = createTypingAnnouncer({
			intervalMs: 10_000,
			announce: (text) => spoken.push(text),
			now: () => clock,
			setTimer: (run, ms) => {
				const id = nextId++;
				timers.push({ at: clock + ms, run, id });
				return id;
			},
			clearTimer: (id) => {
				const index = timers.findIndex((timer) => timer.id === id);
				if (index >= 0) timers.splice(index, 1);
			}
		});
		const advance = (ms: number) => {
			clock += ms;
			for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
				if (timer.at <= clock) {
					timers.splice(timers.indexOf(timer), 1);
					timer.run();
				}
			}
		};
		return { announcer, spoken, advance, timers };
	}

	test('speaks the first change at once, then waits out the interval with the latest words', () => {
		const { announcer, spoken, advance } = harness();
		announcer.update('Iris is writing');
		expect(spoken).toEqual(['Iris is writing']);
		advance(2_000);
		announcer.update('Iris and Leo are writing');
		announcer.update('Several people are writing');
		expect(spoken).toEqual(['Iris is writing']);
		advance(8_000);
		expect(spoken).toEqual(['Iris is writing', 'Several people are writing']);
	});

	test('the same words are never repeated, and a row that empties is cleared without a word', () => {
		const { announcer, spoken, advance, timers } = harness();
		announcer.update('Iris is writing');
		announcer.update('Iris is writing');
		advance(1_000);
		announcer.update('Iris and Leo are writing');
		announcer.update('');
		expect(timers).toHaveLength(0);
		expect(spoken).toEqual(['Iris is writing', '']);
		advance(20_000);
		expect(spoken).toEqual(['Iris is writing', '']);
	});

	test('dispose drops anything queued', () => {
		const { announcer, spoken, advance, timers } = harness();
		announcer.update('Iris is writing');
		announcer.update('Leo is writing');
		announcer.dispose();
		expect(timers).toHaveLength(0);
		advance(20_000);
		expect(spoken).toEqual(['Iris is writing']);
	});
});

describe('ChatMessagesPane: typing row, empty room, search toolbar', () => {
	const pane = readFileSync(new URL('./ChatMessagesPane.svelte', import.meta.url), 'utf8');

	test('the typing row keeps its slot and one polite live region that exists before it speaks', () => {
		const row = pane.slice(pane.indexOf('<div class="stream-typing">'), pane.indexOf('</div>\n\t</div>\n{/key}'));
		expect(row).toContain('<span class="sr-only" aria-live="polite">{typingAnnouncement}</span>');
		expect(row.indexOf('aria-live')).toBeGreaterThan(row.indexOf('{/if}'));
		expect(row).toContain('class="w-typing stream-typing__row" aria-hidden="true"');
		expect(row).toContain('<span class="w-typing__dots"><i></i><i></i><i></i></span>');
		expect(pane).toContain('createTypingAnnouncer({ announce: (text) => (typingAnnouncement = text) })');
		expect(pane).not.toContain('typing-indicator');
	});

	test('an empty room is the start-of-channel block with one next step, not a centered box with a glyph', () => {
		expect(pane).toContain('<div class="stream-start stream-start--empty">');
		expect(pane).toContain("$_('messages.start_of', { values: { channel: roomName } })");
		expect(pane).not.toContain('{emptyStateIcon}');
		expect(pane).not.toMatch(/class="empty-state/);
	});

	test('the in-stream search toolbar uses kit buttons and sentence case', () => {
		expect(pane).toContain('Search on the web');
		expect(pane).not.toContain('Search on Web');
		expect(pane).not.toMatch(/btn-ghost|search-toolbar-btn/);
		expect(pane).toContain('class="w-btn w-btn--sm w-btn--quiet"');
	});
});
