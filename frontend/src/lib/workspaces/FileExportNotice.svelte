<!--
	File export status (design contract §8.8): the exporter's words, verbatim, as a toast. Never a
	band that pushes the editor down. "Saving…" stays up until the result replaces it; a failure or
	an uncertain result is announced assertively and stays longer. Renders nothing itself.
-->
<script lang="ts">
	import { workspaceExportState, dismissExportStatus } from './fileExport';
	import { toast, type ToastHandle } from '$lib/toast';

	let shown: ToastHandle | null = null;
	let lastKey = '';

	$effect(() => {
		const state = $workspaceExportState;
		if (state.phase === 'idle') {
			lastKey = '';
			return;
		}
		const key = `${state.phase}|${state.message}`;
		if (key === lastKey) return;
		lastKey = key;
		shown?.dismiss();
		const attention = state.phase === 'error' || state.phase === 'uncertain';
		shown = toast(state.message, {
			tone: state.phase === 'error' ? 'error' : state.phase === 'uncertain' ? 'warning' : 'info',
			timeout: state.phase === 'saving' ? 60000 : attention ? 12000 : 6000
		});
		// The toast now carries the words; a finished export returns the store to idle so the
		// next one is announced again.
		if (state.phase !== 'saving') dismissExportStatus();
	});
</script>
