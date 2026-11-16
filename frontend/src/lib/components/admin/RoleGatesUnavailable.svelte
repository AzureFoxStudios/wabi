<script lang="ts">
	import { _ } from '$lib/i18n';
</script>
<section class="admin-section role-gates-unavailable" aria-labelledby="role-gates-heading">
	<h4 id="role-gates-heading">{$_('rga.heading')}</h4>
	<p class="role-gates-status">{$_('rga.status')}</p>
	<p>{$_('rga.body')}</p>
	<div class="role-gates-alternatives">
		<p><strong>{$_('rga.assign_label')}</strong> {$_('jump.hint_open')} <strong>{$_('admin.stats.users')}</strong> {$_('rga.assign_post')}</p>
		<p><strong>{$_('rga.keep_label')}</strong> {$_('rga.keep_text')}</p>
	</div>
</section>

<style>
	.role-gates-unavailable { min-width: 0; gap: 12px; }
	h4 { margin: 0; color: var(--w-text); }
	p { margin: 0; font-size: 0.875rem; color: var(--w-mute); line-height: 1.6; text-wrap: pretty; overflow-wrap: anywhere; }
	.role-gates-status { color: var(--w-text); font-weight: 500; }
	.role-gates-alternatives { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--w-line); padding-top: 12px; }
</style>
