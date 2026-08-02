<script lang="ts">
	import { onMount, type Component } from 'svelte';
	import Prism from 'prismjs';
	import 'prismjs/components/prism-clike';
	import 'prismjs/components/prism-javascript';
	import 'prismjs/components/prism-typescript';
	import 'prismjs/components/prism-markup';
	import 'prismjs/components/prism-css';
	import 'prismjs/components/prism-json';
	import 'prismjs/components/prism-markdown';
	import 'prismjs/components/prism-python';
	import 'prismjs/components/prism-c';
	import 'prismjs/components/prism-cpp';
	import 'prismjs/components/prism-csharp';
	import 'prismjs/components/prism-go';
	import 'prismjs/components/prism-rust';
	import 'prismjs/components/prism-bash';
	import 'prismjs/components/prism-java';
	import 'prismjs/components/prism-ruby';
	import '$lib/prism-theme.css';

	// Compile-time constant: true for the desktop Tauri build, false for web.
	// Keeps the CodeMirror editor out of the web bundle entirely.
	const isTauriBuild = __WABI_IS_TAURI__;

	let { code = '', language = 'javascript', onupdate }: {
		code?: string;
		language?: string;
		onupdate?: (value: string) => void;
	} = $props();

	let CodeMirrorEditor: Component<any> | null = $state(null);
	let editorError = $state(false);

	onMount(async () => {
		if (!isTauriBuild) return;
		try {
			const mod = await import('./CodeMirrorEditor.svelte');
			CodeMirrorEditor = mod.default as Component<any>;
		} catch (error) {
			console.error('[CodeBlockEditor] CodeMirror editor failed to load:', error);
			editorError = true;
		}
	});

	function prismLanguage(name: string): string {
		switch (name) {
			case 'typescript':
			case 'ts':
			case 'tsx':
				return 'typescript';
			case 'javascript':
			case 'js':
			case 'jsx':
				return 'javascript';
			case 'python':
			case 'py':
				return 'python';
			case 'c':
			case 'h':
				return 'c';
			case 'cpp':
			case 'c++':
			case 'cc':
			case 'hpp':
				return 'cpp';
			case 'csharp':
			case 'cs':
				return 'csharp';
			case 'go':
			case 'golang':
				return 'go';
			case 'rust':
			case 'rs':
				return 'rust';
			case 'bash':
			case 'sh':
			case 'shell':
			case 'zsh':
				return 'bash';
			case 'json':
				return 'json';
			case 'css':
				return 'css';
			case 'html':
			case 'markup':
				return 'markup';
			case 'markdown':
			case 'md':
				return 'markdown';
			case 'java':
				return 'java';
			case 'ruby':
			case 'rb':
				return 'ruby';
			default:
				return 'plain';
		}
	}

	function escapeHtml(text: string): string {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	const previewHtml = $derived.by(() => {
		const langId = prismLanguage(language);
		const grammar = Prism.languages[langId];
		if (!grammar) return escapeHtml(code);
		try {
			return Prism.highlight(code, grammar, langId);
		} catch (error) {
			console.warn('[CodeBlockEditor] Prism highlighting failed:', error);
			return escapeHtml(code);
		}
	});
</script>

{#if isTauriBuild && CodeMirrorEditor}
	{@const Comp = CodeMirrorEditor}
	<Comp bind:code {language} {onupdate} />
{:else if isTauriBuild && editorError}
	<div class="editor-error">
		<p class="editor-error-msg">CodeMirror editor could not be loaded — showing a read-only preview instead.</p>
		<pre class="code-preview"><code class="language-{prismLanguage(language)}">{@html previewHtml}</code></pre>
	</div>
{:else}
	<pre class="code-preview"><code class="language-{prismLanguage(language)}">{@html previewHtml}</code></pre>
{/if}

<style>
	.code-preview {
		width: 100%;
		max-width: 100%;
		margin: 0;
		padding: var(--space-3, 0.75rem);
		overflow: auto;
		border: 1px solid var(--surface-raised, #302b63);
		border-radius: var(--radius-md, 8px);
		background: var(--surface-sunken, #0f0c29);
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: var(--text-sm, 0.875rem);
		line-height: 1.55;
		white-space: pre;
		tab-size: 4;
	}
	.code-preview :global(code) {
		background: transparent;
		font-family: inherit;
	}
	.editor-error {
		width: 100%;
	}
	.editor-error-msg {
		margin: 0 0 var(--space-2, 0.5rem);
		font-size: var(--text-sm, 0.875rem);
		color: var(--text-muted, #9999ff);
	}
</style>
