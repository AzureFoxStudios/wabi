<script lang="ts">
	export let node: any;
</script>

<div class="tag-node">
	<span class="tag-label">#{node.data?.label || node.label}</span>
</div>

<style>
	.tag-node {
		background: #6366f1;
		border-radius: 4px;
		padding: 8px 16px;
		font-size: 12px;
		font-weight: bold;
		color: #fff;
		min-width: 60px;
		text-align: center;
	}

	.tag-label {
		white-space: nowrap;
	}
</style>
