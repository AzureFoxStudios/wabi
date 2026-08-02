<script lang="ts">
	import { untrack } from 'svelte';
	import {
		EditorView,
		keymap,
		lineNumbers,
		highlightActiveLine,
		highlightActiveLineGutter,
		highlightSpecialChars,
		drawSelection,
		dropCursor,
		rectangularSelection,
		crosshairCursor
	} from '@codemirror/view';
	import { EditorState, Transaction, type Extension } from '@codemirror/state';
	import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
	import { oneDark } from '@codemirror/theme-one-dark';
	import { javascript } from '@codemirror/lang-javascript';
	import { css } from '@codemirror/lang-css';
	import { html } from '@codemirror/lang-html';
	import { json } from '@codemirror/lang-json';
	import { markdown } from '@codemirror/lang-markdown';
	import { python } from '@codemirror/lang-python';
	import { rust } from '@codemirror/lang-rust';
	import { cpp } from '@codemirror/lang-cpp';
	import { go } from '@codemirror/lang-go';
	import { java } from '@codemirror/lang-java';

	let { code = $bindable(''), language = 'javascript', readonly = false, onupdate }: {
		code?: string;
		language?: string;
		readonly?: boolean;
		onupdate?: (value: string) => void;
	} = $props();

	function languageExtension(name: string): Extension {
		switch (name) {
			case 'javascript':
			case 'js':
			case 'jsx':
				return javascript({ jsx: true });
			case 'typescript':
			case 'ts':
			case 'tsx':
				return javascript({ typescript: true, jsx: true });
			case 'css':
				return css();
			case 'html':
			case 'markup':
				return html();
			case 'json':
				return json();
			case 'markdown':
			case 'md':
				return markdown();
			case 'python':
			case 'py':
				return python();
			case 'rust':
			case 'rs':
				return rust();
			case 'c':
			case 'cpp':
			case 'c++':
			case 'cc':
			case 'h':
			case 'hpp':
				return cpp();
			case 'go':
			case 'golang':
				return go();
			case 'java':
				return java();
			default:
				return [];
		}
	}

	function buildState(): EditorState {
		return EditorState.create({
			doc: code,
			extensions: [
				lineNumbers(),
				highlightActiveLineGutter(),
				highlightSpecialChars(),
				history(),
				drawSelection(),
				dropCursor(),
				EditorState.allowMultipleSelections.of(true),
				rectangularSelection(),
				crosshairCursor(),
				highlightActiveLine(),
				keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
				languageExtension(language),
				oneDark,
				EditorState.readOnly.of(readonly),
				EditorView.updateListener.of((update) => {
					if (!update.docChanged) return;
					const isUserEdit = update.transactions.some(
						(tr) => tr.annotation(Transaction.userEvent) !== undefined
					);
					if (isUserEdit) {
						code = update.state.doc.toString();
						onupdate?.(code);
					}
				})
			]
		});
	}

	let host: HTMLDivElement;
	let view: EditorView | null = $state(null);

	$effect(() => {
		if (!host) return;
		const editor = new EditorView({ state: untrack(buildState), parent: host });
		view = editor;
		return () => {
			editor.destroy();
			view = null;
		};
	});

	$effect(() => {
		const editor = view;
		if (!editor) return;
		const doc = editor.state.doc.toString();
		if (code !== doc) {
			editor.dispatch({ changes: { from: 0, to: doc.length, insert: code } });
		}
	});
</script>

<div class="cm-editor" class:readonly>
	<div bind:this={host} class="cm-editor-host"></div>
</div>

<style>
	.cm-editor {
		display: flex;
		flex-direction: column;
		width: 100%;
		min-height: 0;
		overflow: hidden;
		border: 1px solid var(--surface-raised, #302b63);
		border-radius: var(--radius-md, 8px);
		background: var(--surface-sunken, #0f0c29);
	}
	.cm-editor-host {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: var(--text-sm, 0.875rem);
	}
	.cm-editor-host :global(.cm-editor) {
		height: 100%;
	}
	.cm-editor-host :global(.cm-scroller) {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: var(--text-sm, 0.875rem);
	}
</style>
