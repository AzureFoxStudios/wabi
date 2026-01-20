<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';

	interface Props {
		data: {
			label: string;
			isTag: boolean;
		};
	}

	let { data }: Props = $props();
</script>

<Handle type="target" position={Position.Top} />

<div class="tag-node">
	<div class="tag-content">
		<span class="tag-icon">🏷️</span>
		<span class="tag-label">{data.label}</span>
	</div>
</div>

<Handle type="source" position={Position.Bottom} />

<style>
	.tag-node {
		background: linear-gradient(135deg, #6366f1 0%, #7c3aed 100%);
		border: 2px solid #a78bfa;
		border-radius: 20px;
		padding: 10px 16px;
		min-width: 120px;
		box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
		transition: all 0.2s;
	}

	.tag-node:hover {
		border-color: #10b981;
		box-shadow: 0 0 20px rgba(16, 185, 129, 0.4);
		transform: scale(1.1);
	}

	.tag-content {
		display: flex;
		align-items: center;
		gap: 8px;
		justify-content: center;
	}

	.tag-icon {
		font-size: 1.2rem;
	}

	.tag-label {
		font-size: 0.9rem;
		font-weight: 700;
		color: white;
		text-align: center;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
