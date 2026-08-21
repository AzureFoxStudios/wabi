<script lang="ts">
	import { currentUser } from '$lib/socket';
	import type { ItemSignature } from '$lib/business/types';

	/**
	 * Sign-off row for planner items (tasks, events, projects, sprints, journal).
	 * Replaces the old mystery "Sign this … with my username" checkbox.
	 *
	 * - Signed state: chips with name + relative time; your own chip is removable.
	 * - Unsigned: quiet "+ Sign off" button.
	 * - Legacy items with only `signedBy` render as a single read-only chip
	 *   (no `at` timestamp known, no removal — the legacy field is not authoritative).
	 */
	export let signatures: ItemSignature[] = [];
	/** Legacy single-signer name (read-only display only). */
	export let legacySignedBy: string | undefined = undefined;
	/** Two-way bound draft used by forms before submit. */
	export let draftSignatures: ItemSignature[] = [];
	export let disabled = false;
	export let label = 'Sign-off';

	function me(): { by: string; name: string } | null {
		const u = $currentUser;
		if (!u) return null;
		const by = u.dbUserId ? String(u.dbUserId) : u.id || '';
		const name = u.username || 'Guest';
		if (!by) return null;
		return { by, name };
	}

	$: allSignatures = [...draftSignatures, ...signatures];
	$: mySigIndex = allSignatures.findIndex((s) => {
		const m = me();
		return m ? s.by === m.by : false;
	});

	function relTime(at: number): string {
		const diff = Date.now() - at;
		const mins = Math.floor(diff / 60000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		if (days < 7) return `${days}d ago`;
		return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}

	function toggleSign(): void {
		if (disabled) return;
		const m = me();
		if (!m) return;
		if (mySigIndex >= 0) {
			draftSignatures = draftSignatures.filter((s) => s.by !== m.by);
		} else {
			draftSignatures = [...draftSignatures, { by: m.by, name: m.name, at: Date.now() }];
		}
	}
</script>

<div class="sig-row" role="group" aria-label={label}>
	<span class="sig-label">{label}</span>
	<div class="sig-chips">
		{#each legacySignedBy && allSignatures.length === 0 ? [{ by: legacySignedBy, name: legacySignedBy, at: 0 }] : allSignatures as sig (sig.by + ':' + sig.at)}
			<span class="sig-chip" class:legacy={sig.at === 0} title={sig.at ? `Signed ${new Date(sig.at).toLocaleString()}` : 'Signed (legacy)'}>
				<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M12 20h9" />
					<path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
				</svg>
				<span class="sig-name">{sig.name}</span>
				{#if sig.at}<span class="sig-time">{relTime(sig.at)}</span>{/if}
			</span>
		{/each}

		{#if !disabled}
			<button
				type="button"
				class="sig-toggle"
				class:signed={mySigIndex >= 0}
				on:click={toggleSign}
				title={mySigIndex >= 0 ? 'Remove your sign-off' : 'Sign off with your name'}
			>
				{#if mySigIndex >= 0}
					<span aria-hidden="true">✓</span> Signed
				{:else}
					<span aria-hidden="true">＋</span> Sign off
				{/if}
			</button>
		{/if}
	</div>
</div>

<style>
	.sig-row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
		padding: 8px 10px;
		border-radius: var(--radius-md, 8px);
		background: color-mix(in srgb, var(--biz-bg-secondary, #24243e) 72%, transparent);
		border: 1px solid var(--biz-border, rgba(255, 255, 255, 0.08));
	}
	.sig-label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--biz-text-muted, #9999ff);
	}
	.sig-chips {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 6px;
		min-height: 26px;
	}
	.sig-chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 2px 9px;
		border-radius: 999px;
		font-size: 12px;
		color: var(--biz-text-primary, #e0e0ff);
		background: color-mix(in srgb, var(--biz-accent, #6366f1) 14%, transparent);
		border: 1px solid color-mix(in srgb, var(--biz-accent, #6366f1) 30%, transparent);
	}
	.sig-chip.legacy {
		background: color-mix(in srgb, var(--biz-text-muted, #9999ff) 10%, transparent);
		border-color: color-mix(in srgb, var(--biz-text-muted, #9999ff) 22%, transparent);
		color: var(--biz-text-secondary, #b3b3ff);
	}
	.sig-name {
		font-weight: 500;
	}
	.sig-time {
		font-size: 10px;
		color: var(--biz-text-muted, #9999ff);
	}
	.sig-toggle {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		border: 1px dashed color-mix(in srgb, var(--biz-accent, #6366f1) 45%, transparent);
		background: transparent;
		color: var(--biz-accent, #6366f1);
		font: inherit;
		font-size: 12px;
		font-weight: 500;
		padding: 3px 10px;
		border-radius: 999px;
		cursor: pointer;
		min-height: 26px;
		transition:
			background 120ms ease,
			border-color 120ms ease,
			color 120ms ease;
	}
	.sig-toggle:hover {
		background: color-mix(in srgb, var(--biz-accent, #6366f1) 12%, transparent);
	}
	.sig-toggle.signed {
		border-style: solid;
		background: color-mix(in srgb, var(--biz-success, #22c55e) 14%, transparent);
		border-color: color-mix(in srgb, var(--biz-success, #22c55e) 40%, transparent);
		color: var(--biz-success, #22c55e);
	}
	.sig-toggle:focus-visible {
		outline: 2px solid var(--biz-accent, #6366f1);
		outline-offset: 2px;
	}
</style>
