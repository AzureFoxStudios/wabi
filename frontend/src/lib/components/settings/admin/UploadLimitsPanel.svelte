<script lang="ts">
	import type { UploadRoleTier } from '$lib/api';

	export let canManageAdmin: boolean;
	export let loadingUploadLimits: boolean;
	export let savingUploadLimits: boolean;
	export let uploadRoleOrder: UploadRoleTier[];
	export let uploadRoleLabels: Record<UploadRoleTier, string>;
	export let uploadLimitInputs: Record<UploadRoleTier, string>;
	export let globalUploadLimitInput: string;
	export let onSave: () => void;

	function onInput(tier: UploadRoleTier, value: string) {
		uploadLimitInputs[tier] = value;
	}
	function onGlobalInput(value: string) {
		globalUploadLimitInput = value;
	}
</script>

<div class="upload-limits-panel">
	<h4>Upload Limits (MB)</h4>
	<p class="admin-help">Leave a field blank for unlimited. These limits are enforced on the backend.</p>
	<div class="upload-limit-grid">
		{#each uploadRoleOrder as tier}
			<label class="upload-limit-row">
				<span>{uploadRoleLabels[tier]}</span>
				<input
					type="number"
					min="1"
					step="1"
					placeholder="Unlimited"
					value={uploadLimitInputs[tier]}
					on:input={(e) => onInput(tier, (e.currentTarget as HTMLInputElement).value)}
					disabled={!canManageAdmin || loadingUploadLimits || savingUploadLimits}
				/>
			</label>
		{/each}
		<label class="upload-limit-row">
			<span>Global Cap</span>
			<input
				type="number"
				min="1"
				step="1"
				placeholder="Unlimited"
				value={globalUploadLimitInput}
				on:input={(e) => onGlobalInput((e.currentTarget as HTMLInputElement).value)}
				disabled={!canManageAdmin || loadingUploadLimits || savingUploadLimits}
			/>
		</label>
	</div>
	<button class="action-btn" on:click={onSave} disabled={!canManageAdmin || loadingUploadLimits || savingUploadLimits}>
		{savingUploadLimits ? 'Saving...' : 'Save Upload Limits'}
	</button>
</div>
