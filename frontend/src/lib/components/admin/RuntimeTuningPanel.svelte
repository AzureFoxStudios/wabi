<script lang="ts">
	import type { AdminRuntimeGuardrailsResponse, RuntimeTuningConfig } from '$lib/api';

	export let runtimePanel: AdminRuntimeGuardrailsResponse | null;
	export let runtimeTuningDraft: RuntimeTuningConfig;
	export let runtimeLoading: boolean;
	export let runtimeSaving: boolean;
	export let runtimeError: string;
	export let runtimeSaveStatus: string;
	export let onRefresh: () => void;
	export let onSave: () => void;
	export let onDraftChange: (draft: RuntimeTuningConfig) => void;

	function formatBytes(bytes: number): string {
		if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
		return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
	}

	function formatNumber(value: number | null, digits = 2): string {
		if (value == null || !Number.isFinite(value)) return 'n/a';
		return Number(value).toFixed(digits);
	}
</script>

<div class="admin-section">
	<div class="compression-header">
		<h4>Runtime Tuning (Restart Applied)</h4>
		<div class="compression-actions">
			<button class="admin-btn" disabled={runtimeLoading || runtimeSaving} on:click={onRefresh}>
				{runtimeLoading ? 'Loading...' : 'Refresh'}
			</button>
			<button class="admin-btn" disabled={runtimeLoading || runtimeSaving} on:click={onSave}>
				{runtimeSaving ? 'Saving...' : 'Save'}
			</button>
		</div>
	</div>

	{#if runtimeError}
		<div class="admin-empty">{runtimeError}</div>
	{:else if runtimePanel}
		<div class="runtime-form-grid">
			<label>
				Thread Pool Size
				<input
					type="number"
					min="1"
					max="64"
					placeholder="auto"
					value={runtimeTuningDraft.threadPoolSize ?? ''}
					on:input={(e) => {
						const v = (e.currentTarget as HTMLInputElement).value;
						onDraftChange({ ...runtimeTuningDraft, threadPoolSize: v ? Number(v) : null });
					}}
				/>
			</label>
			<label>
				Heavy Profiling Sample Rate
				<input
					type="number"
					min="0.01"
					max="1"
					step="0.01"
					value={runtimeTuningDraft.heavyProfilingSampleRate}
					on:input={(e) => {
						const v = Number((e.currentTarget as HTMLInputElement).value);
						if (Number.isFinite(v)) onDraftChange({ ...runtimeTuningDraft, heavyProfilingSampleRate: v });
					}}
				/>
			</label>
			<label class="runtime-checkbox">
				<input type="checkbox" checked={runtimeTuningDraft.heavyProfilingEnabled} on:change={(e) => onDraftChange({ ...runtimeTuningDraft, heavyProfilingEnabled: (e.currentTarget as HTMLInputElement).checked })} />
				Enable heavy profiling
			</label>
		</div>

		<div class="runtime-hint">
			Restart required after save. Lightweight counters stay active; heavy profiling loads only when enabled.
		</div>
		{#if runtimeSaveStatus}
			<div class="runtime-hint">{runtimeSaveStatus}</div>
		{/if}

		<div class="compression-grid">
			<div class="compression-stat">
				<span class="k">Restart Required</span>
				<span class="v">{runtimePanel.runtimeTuning.restartRequired ? 'Yes' : 'No'}</span>
			</div>
			<div class="compression-stat">
				<span class="k">Effective UV Pool</span>
				<span class="v">{runtimePanel.runtimeTuning.effective.uvThreadpoolSize ?? 'auto'}</span>
			</div>
			<div class="compression-stat">
				<span class="k">RSS</span>
				<span class="v">{formatBytes(runtimePanel.guardrails.memory.rssBytes)}</span>
			</div>
			<div class="compression-stat">
				<span class="k">Heap Used</span>
				<span class="v">{formatBytes(runtimePanel.guardrails.memory.heapUsedBytes)}</span>
			</div>
			<div class="compression-stat">
				<span class="k">CPU User (ms)</span>
				<span class="v">{formatNumber(runtimePanel.guardrails.cpu.userMicros / 1000)}</span>
			</div>
			<div class="compression-stat">
				<span class="k">EL Delay P95 (ms)</span>
				<span class="v">{formatNumber(runtimePanel.guardrails.heavyProfiling.eventLoopDelayP95Ms)}</span>
			</div>
		</div>
	{:else}
		<div class="admin-empty">No runtime tuning data yet.</div>
	{/if}
</div>


