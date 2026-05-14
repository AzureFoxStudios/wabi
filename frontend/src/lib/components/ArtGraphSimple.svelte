<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import {
		SvelteFlow,
		Background,
		Controls
	} from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';
	import { get, derived } from 'svelte/store';
	import { resources, graphEdges } from '$lib/business/store';
	import ResourceNodeComponent from './nodes/ResourceNodeComponent.svelte';
	import TagNodeComponent from './nodes/TagNodeComponent.svelte';

	export let highlightNodeId: string | null = null;
	export let layout: 'community' | 'radial' | 'force-directed' | 'timeline' = 'community';

	let nodes: any[] = [];
	let edges: any[] = [];
	let selectedNodeId: string | null = null;

	function getNodePosition(nodeId: string, allResources: any[] = get(resources)): { x: number; y: number } {

		if (layout === 'community') {
			return computeCommunityPosition(nodeId, allResources);
		} else if (layout === 'radial') {
			return { x: Math.random() * 1600, y: Math.random() * 1200 };
		} else if (layout === 'force-directed') {
			return { x: Math.random() * 1600, y: Math.random() * 1200 };
		} else { // timeline
			const index = allResources.findIndex((r: any) => r.id === nodeId);
			const angle = index * 0.5;
			const radius = 200 + (index * 20);
			return {
				x: 800 + Math.cos(angle) * radius,
				y: 600 + Math.sin(angle) * radius
			};
		}
	}

	function computeCommunityPosition(nodeId: string, allResources: any[]): { x: number; y: number } {
		const node = allResources.find((r: any) => r.id === nodeId);
		if (!node || !node.tags || node.tags.length === 0) {
			return { x: Math.random() * 1600, y: Math.random() * 1200 };
		}

		const primaryTag = node.tags[0];
		const taggedResources = allResources.filter((r: any) =>
			r.id !== nodeId && r.tags && r.tags.includes(primaryTag)
		);

		const clusterIndex = taggedResources.findIndex((r: any) => r.id === nodeId);
		const clusterCount = taggedResources.length;
		const angle = (clusterIndex / clusterCount) * 2 * Math.PI;
		const radius = 400 + (clusterCount * 5);

		// Check if it's a tag node
		if (nodeId.startsWith('tag-')) {
			const tagIndex = Array.from(new Set(allResources.flatMap((r: any) => r.tags || []))).indexOf(nodeId.replace('tag-', ''));
			const totalTags = new Set(allResources.flatMap((r: any) => r.tags || [])).size;
			const tagAngle = (tagIndex / totalTags) * 2 * Math.PI;
			return {
				x: 800 + Math.cos(tagAngle) * 800,
				y: 600 + Math.sin(tagAngle) * 600
			};
		}

		return {
			x: 800 + Math.cos(angle) * radius,
			y: 600 + Math.sin(angle) * radius
		};
	}

	$: if (highlightNodeId && highlightNodeId !== selectedNodeId) {
		selectedNodeId = highlightNodeId;
	}

	// Build nodes from resources
	$: {
		const $resources = get(resources);
		const $graphEdges = get(graphEdges);

		// Resource nodes
		const resourceNodes: any[] = $resources.map(r => ({
			id: r.id,
			type: 'resourceNode',
			position: getNodePosition(r.id, $resources),
			data: {
				label: r.name,
				author: r.createdBy,
				isAnonymous: r.isAnonymous,
				type: r.type,
				preview: r.preview,
				tags: r.tags || [],
				thumbnail: r.preview
			}
		}));

		// Tag nodes (for community layout)
		const tagNodes: any[] = [];
		if (layout === 'community') {
			const uniqueTags = new Set($resources.flatMap((r: any) => r.tags || []));
			tagNodes.push(...Array.from(uniqueTags).map((tag: string) => ({
				id: `tag-${tag}`,
				type: 'tagNode',
				position: { x: 0, y: 0 },
				data: { label: tag, isTag: true }
			})));
		}

		nodes = [...resourceNodes, ...tagNodes];

		// Edge nodes
		edges = $graphEdges.map((e: any) => ({
			id: e.id,
			source: e.source,
			target: e.target,
			animated: true,
			data: { type: e.type, label: e.label }
		}));
	}
</script>

<div class="art-graph-container">
	<SvelteFlow
		bind:nodes
		bind:edges
		class="art-graph"
	>
		<Background />
		<Controls />
	</SvelteFlow>

	<!-- Node components -->
	{#each nodes as node}
		{#if node.type === 'resourceNode'}
			<ResourceNodeComponent
				{node}
				selected={selectedNodeId === node.id}
			/>
		{:else if node.type === 'tagNode'}
			<TagNodeComponent {node} />
		{/if}
	{/each}

	<!-- SVG edges -->
	<svg class="edges-layer">
		{#each edges as edge}
			<line
				x1={nodes.find((n: any) => n.id === edge.source)?.position?.x || 0}
				y1={nodes.find((n: any) => n.id === edge.source)?.position?.y || 0}
				x2={nodes.find((n: any) => n.id === edge.target)?.position?.x || 0}
				y2={nodes.find((n: any) => n.id === edge.target)?.position?.y || 0}
				class="graph-edge {selectedNodeId === edge.source || selectedNodeId === edge.target ? 'selected' : ''}"
			/>
			{#if edge.data?.label}
				<text
					x={(getNodePosition(edge.source, get(resources)).x + getNodePosition(edge.target, get(resources)).x) / 2}
					y={(getNodePosition(edge.source, get(resources)).y + getNodePosition(edge.target, get(resources)).y) / 2 - 10}
					class="edge-label"
				>
					{edge.data.label}
				</text>
			{/if}
		{/each}
	</svg>
</div>

<style>
	.art-graph-container {
		width: 100%;
		height: 100%;
		position: relative;
		background: var(--surface-app, #1a1a1e);
	}

	:global(.art-graph) {
		background: var(--surface-app, #1a1a1e);
		width: 100%;
		height: 100%;
	}

	:global(.art-graph .svelte-flow__node) {
		cursor: pointer;
	}

	.edges-layer {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
		z-index: 1;
	}

	.graph-edge {
		stroke: var(--color-info, var(--color-info, #6366f1));
		stroke-width: 2px;
	}

	.graph-edge:hover {
		stroke: var(--color-success, var(--color-success, #10b981));
		stroke-width: 3px;
	}

	.edge-label {
		fill: var(--text-inverse, #fff);
		font-size: 11px;
		font-family: sans-serif;
		text-anchor: middle;
	}
</style>
