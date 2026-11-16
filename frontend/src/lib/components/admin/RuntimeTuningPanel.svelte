<script lang="ts">
	import { _ } from '$lib/i18n';
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

	function formatBytes(bytes: number | null): string {
		if (bytes == null || !Number.isFinite(bytes)) return $_('network_health.not_measured');
		if (bytes <= 0) return '0 B';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
		return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
	}

	function formatNumber(value: number | null, digits = 2): string {
		if (value == null || !Number.isFinite(value)) return $_('payment_intent.na');
		return Number(value).toFixed(digits);
	}
</script>

<div class="admin-section">
	<div class="compression-header">
		<h4>{$_('rtp.title')}</h4>
		<div class="compression-actions">
			<button class="admin-btn" disabled={runtimeLoading || runtimeSaving} on:click={onRefresh}>
				{runtimeLoading ? $_('compression.loading') : $_('yt.refresh')}
			</button>
			<button class="admin-btn" disabled={runtimeLoading || runtimeSaving} on:click={onSave}>
				{runtimeSaving ? $_('donation_config.saving') : $_('common.save')}
			</button>
		</div>
	</div>

	{#if runtimeError}
		<div class="admin-empty">{runtimeError}</div>
	{:else if runtimePanel}
		<div class="runtime-form-grid">
			<label>
				{$_('rtp.thread_pool')}
				<input
					type="number"
					min="1"
					max="64"
					placeholder={$_('rtp.auto')}
					value={runtimeTuningDraft.threadPoolSize ?? ''}
					on:input={(e) => {
						const v = (e.currentTarget as HTMLInputElement).value;
						onDraftChange({ ...runtimeTuningDraft, threadPoolSize: v ? Number(v) : null });
					}}
				/>
			</label>
			<label>
				{$_('rtp.profiling_rate')}
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
				{$_('rtp.enable_profiling')}
			</label>
		</div>

		<div class="runtime-hint">
			{$_('rtp.restart_hint')}
		</div>
		{#if runtimeSaveStatus}
			<div class="runtime-hint">{runtimeSaveStatus}</div>
		{/if}

		<div class="compression-grid">
			<div class="compression-stat">
				<span class="k">{$_('rtp.restart_req')}</span>
				<span class="v">{runtimePanel.runtimeTuning.restartRequired ? $_('yt.yes') : $_('yt.no')}</span>
			</div>
			<div class="compression-stat">
				<span class="k">{$_('rtp.uv_pool')}</span>
				<span class="v">{runtimePanel.runtimeTuning.effective.uvThreadpoolSize ?? $_('rtp.auto')}</span>
			</div>
			<div class="compression-stat">
				<span class="k">RSS</span>
				<span class="v">{formatBytes(runtimePanel.guardrails.memory.rssBytes)}</span>
			</div>
			<div class="compression-stat">
				<span class="k">{$_('rtp.heap')}</span>
				<span class="v">{formatBytes(runtimePanel.guardrails.memory.heapUsedBytes)}</span>
			</div>
			<div class="compression-stat">
				<span class="k">{$_('rtp.cpu_user')}</span>
				<span class="v">{formatNumber(runtimePanel.guardrails.cpu.userMicros == null ? null : runtimePanel.guardrails.cpu.userMicros / 1000)}</span>
			</div>
			<div class="compression-stat">
				<span class="k">{$_('rtp.el_p95')}</span>
				<span class="v">{formatNumber(runtimePanel.guardrails.heavyProfiling.eventLoopDelayP95Ms)}</span>
			</div>
		</div>
	{:else}
		<div class="admin-empty">{$_('rtp.no_data')}</div>
	{/if}
</div>


