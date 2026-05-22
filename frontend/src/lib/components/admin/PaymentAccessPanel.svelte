<script lang="ts">
	export interface PaymentAccessPolicy {
		enabled: boolean;
		allowGuest: boolean;
		allowedRoleNames: string[];
	}

	export interface PaymentUserBlock {
		userId: number;
		reason: string;
	}

	export interface RoleDef {
		roleName: string;
		displayName: string;
	}

	export let paymentPolicy: PaymentAccessPolicy;
	export let paymentUserBlocks: PaymentUserBlock[];
	export let paymentPolicyLoading: boolean;
	export let paymentPolicySaving: boolean;
	export let paymentPolicyError: string;
	export let paymentPolicySaveStatus: string;
	export let roleDefinitions: RoleDef[];
	export let getRoleLabel: (roleName?: string) => string;
	export let onPolicyChange: (policy: PaymentAccessPolicy) => void;
	export let onRefresh: () => void;
	export let onSave: () => void;
</script>

<div class="admin-section">
	<div class="compression-header">
		<h4>Payments Access Control</h4>
		<div class="compression-actions">
			<button class="admin-btn" disabled={paymentPolicyLoading || paymentPolicySaving} on:click={onRefresh}>
				{paymentPolicyLoading ? 'Loading...' : 'Refresh'}
			</button>
			<button class="admin-btn" disabled={paymentPolicyLoading || paymentPolicySaving} on:click={onSave}>
				{paymentPolicySaving ? 'Saving...' : 'Save'}
			</button>
		</div>
	</div>

	{#if paymentPolicyError}
		<div class="admin-empty">{paymentPolicyError}</div>
	{/if}
	{#if paymentPolicySaveStatus}
		<div class="runtime-hint">{paymentPolicySaveStatus}</div>
	{/if}

	<label class="rule-checkbox">
		<input type="checkbox" checked={paymentPolicy.enabled} on:change={(e) => onPolicyChange({ ...paymentPolicy, enabled: (e.currentTarget as HTMLInputElement).checked })} />
		Enable payments server-wide
	</label>
	<label class="rule-checkbox">
		<input type="checkbox" checked={paymentPolicy.allowGuest} on:change={(e) => onPolicyChange({ ...paymentPolicy, allowGuest: (e.currentTarget as HTMLInputElement).checked })} />
		Allow guests to create payments
	</label>

	<div class="payment-role-grid">
		{#each roleDefinitions as role (role.roleName)}
			<label class="rule-checkbox payment-role-toggle">
				<input
					type="checkbox"
					checked={paymentPolicy.allowedRoleNames.includes(role.roleName.toLowerCase())}
					on:change={(e) => {
						const current = new Set(paymentPolicy.allowedRoleNames.map((r: string) => r.toLowerCase()));
						if ((e.currentTarget as HTMLInputElement).checked) {
							current.add(role.roleName.toLowerCase());
						} else {
							current.delete(role.roleName.toLowerCase());
						}
						onPolicyChange({ ...paymentPolicy, allowedRoleNames: [...current] });
					}}
				/>
				<span>{getRoleLabel(role.roleName)} can create payments</span>
			</label>
		{/each}
	</div>

	<div class="admin-empty">
		User-level payment blocks: {paymentUserBlocks.length}
	</div>
</div>
