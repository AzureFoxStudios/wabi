import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { isOwnMessage } from '$lib/userLookupStore';

const composer = readFileSync(new URL('./ChatComposer.svelte', import.meta.url), 'utf8');
const me = { id: 'sock-1', username: 'ronin', dbUserId: 42 };

// Up arrow on an empty composer edits your last message. It broke after switching channels because the
// messages loaded then carry "user-<dbId>" as their author, not the socket id the composer compared.
test('your message is recognised by socket id, by database id, or by name', () => {
	expect(isOwnMessage({ user: 'someone', userId: 'sock-1' }, me)).toBe(true);
	expect(isOwnMessage({ user: 'someone', userId: 'user-42' }, me)).toBe(true);
	expect(isOwnMessage({ user: 'ronin', userId: 'other' }, me)).toBe(true);
});

test('another person\'s message is not yours, and nobody is signed in means nothing is', () => {
	expect(isOwnMessage({ user: 'sam', userId: 'user-43' }, me)).toBe(false);
	expect(isOwnMessage({ user: 'sam', userId: 'sock-2' }, me)).toBe(false);
	expect(isOwnMessage({ user: 'ronin', userId: 'sock-1' }, null)).toBe(false);
});

test('the composer uses that same test to find the last message to edit', () => {
	expect(composer).toContain('messages.filter((m: Message) => isOwnMessage(m, $currentUser))');
	expect(composer).not.toContain('m.userId === $currentUser?.id');
});

// "When clicking off the message field the buttons stay": the inline :emoji suggestions and the
// /command list were left open because the outside-click handler only closed the emoji picker and
// the @mention list.
test('clicking away closes the :emoji suggestions and the /command list, but not clicks inside them', () => {
	expect(composer).toContain("showEmojiSuggestions = false; showCommandPalette = false;");
	expect(composer).toContain(".closest?.('.emoji-suggestions, .command-palette')");
	expect(composer).toContain('textareaElement?.contains(target)');
});

// "DM message field unable to maintain shape": the field's height was recomputed only on the input event, so a
// restored draft, an edited last message, an inserted mention or a width change (a panel opening) left it the
// wrong height.
test('the field reshapes when its text changes without typing and when its width changes', () => {
	expect(composer).toContain('$effect(() => { void messageInput; void tick().then(() => autoResizeTextarea()); });');
	expect(composer).toContain('new ResizeObserver(() => { const width = textareaElement?.clientWidth ?? 0; if (width !== fieldWidth)');
	expect(composer).toContain('fieldObserver?.disconnect()');
});
