<script lang="ts">
	import { onMount, onDestroy, createEventDispatcher } from 'svelte';
	import {
		SvelteFlow,
		Background,
		Controls,
		type Node,
		type Edge,
		type NodeTypes,
		type Connection
	} from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';
	import { get, derived } from 'svelte/store';
	import { resources, graphEdges, addGraphEdge } from '$lib/business/store';
	import ResourceNode from './ResourceNode.svelte';
	import TagNode from './TagNode.svelte';

	const dispatch = createEventDispatcher();

	export let highlightNodeId: string | null = null;
	export let layout: 'community' | 'radial' | 'force-directed' | 'timeline' = 'community';
	export let workspaceId: string = 'default-workspace';

	// Define custom node types
	const nodeTypes: NodeTypes = {
		resourceNode: ResourceNode,
		tagNode: TagNode
	};

	// Transform business data to Svelte Flow format
	const flowNodes = derived(
		[resources, graphEdges],
		([$resources, $graphEdges]) => {
			// Resource nodes
			const resourceNodes: Node[] = $resources.map(r => ({
				id: r.id,
				type: 'resourceNode',
				position: getNodePosition(r.id, $resources),
				data: {
					label: r.name,
					author: r.createdBy,
					isAnonymous: r.isAnonymous,
					type: r.type,
					preview: r.preview,
					tags: r.tags || []
				}
			}));

			// Tag nodes
			const tagNodes: Node[] = [];
			if (layout === 'community') {
				const uniqueTags = new Set($resources.flatMap(r => r.tags || []));
				tagNodes.push(...Array.from(uniqueTags).map(tag => ({
					id: `tag-${tag}`,
					type: 'tagNode',
					position: getNodePosition(`tag-${tag}`, $resources),
					data: { label: `#${tag}`, isTag: true }
				})));
			}

			return [...resourceNodes, ...tagNodes];
		}
	);

	const flowEdges = derived(
		[graphEdges],
		([$graphEdges]) => {
			return $graphEdges.map(e => ({
				id: e.id,
				source: e.source,
				target: e.target,
				type: 'default',
				data: { edgeType: e.type, label: e.label }
			}));
		}
	);

	let nodes: Node[] = [];
	let edges: Edge[] = [];
	let selectedNodeId: string | null = null;

	function getNodePosition(nodeId: string, allResources: any[]): { x: number; y: number } {
		if (layout === 'community') {
			return computeCommunityPosition(nodeId, allResources);
		}
		return { x: Math.random() * 400 - 200, y: Math.random() * 400 - 200 };
	}

	function computeCommunityPosition(nodeId: string, allResources: any[]): { x: number; y: number } {
		const $resources = get(resources);
		const node = $resources.find((r: any) => r.id === nodeId);

		// Tag nodes - positioned in circle around center
		if (nodeId.startsWith('tag-')) {
			const tagName = nodeId.replace('tag-', '');
			const allTags = Array.from(new Set($resources.flatMap((r: any) => r.tags || [])));
			const tagIndex = allTags.indexOf(tagName);
			const totalTags = allTags.length || 1;
			const tagAngle = (tagIndex / totalTags) * 2 * Math.PI;
			const radius = 300;
			return {
				x: Math.cos(tagAngle) * radius,
				y: Math.sin(tagAngle) * radius
			};
		}

		if (!node || !node.tags || node.tags.length === 0) {
			// New untagged resources spawn near center with small random offset
			return {
				x: (Math.random() - 0.5) * 200,
				y: (Math.random() - 0.5) * 200
			};
		}

		const primaryTag = node.tags[0];
		const taggedResources = $resources.filter((r: any) =>
			r.id !== nodeId && r.tags && r.tags.includes(primaryTag)
		);

		const clusterIndex = taggedResources.findIndex((r: any) => r.id === nodeId);
		const clusterCount = taggedResources.length || 1;
		const angle = (clusterIndex / clusterCount) * 2 * Math.PI;
		const radius = 200 + (clusterCount * 10);

		return {
			x: Math.cos(angle) * radius,
			y: Math.sin(angle) * radius
		};
	}

	function onNodeClick(event: any) {
		const nodeId = event.detail?.node?.id;
		if (nodeId) {
			highlightNodeId = nodeId;
			// Dispatch event to parent component
			dispatch('node-select', nodeId);
		}
	}

	function onNodeDoubleClick(event: any) {
		const nodeId = event.detail?.node?.id;
		const label = event.detail?.node?.data?.label || 'Node';
		if (nodeId) {
			highlightNodeId = nodeId;
			// Dispatch double-click as edit request
			dispatch('node-edit', nodeId);
		}
	}

	function onNodeContextMenu(event: any) {
		// Prevent browser's default context menu
		event.detail?.event?.preventDefault?.();

		const nodeId = event.detail?.node?.id;
		const label = event.detail?.node?.data?.label || 'Node';
		if (nodeId) {
			const mouseEvent = event.detail?.event;
			dispatch('node-context-menu', {
				nodeId,
				label,
				x: mouseEvent?.pageX || 0,
				y: mouseEvent?.pageY || 0
			});
		}
	}

	function onConnect(connection: Connection) {
		if (connection.source && connection.target) {
			const newEdge = addGraphEdge({
				source: connection.source,
				target: connection.target,
				type: 'default',
				label: ''
			});
		}
	}

	// Subscribe to stores
	const unsubscribeNodes = flowNodes.subscribe(n => {
		nodes = n;
	});

	const unsubscribeEdges = flowEdges.subscribe(e => {
		edges = e;
	});

	onDestroy(() => {
		unsubscribeNodes();
		unsubscribeEdges();
	});
</script>

<SvelteFlow
	bind:nodes
	bind:edges
	{nodeTypes}
	connectionMode="loose"
	panOnScroll
	selectNodesOnDrag
	on:nodeclick={onNodeClick}
	on:nodedoubleclick={onNodeDoubleClick}
	on:nodecontextmenu={onNodeContextMenu}
	on:connect={onConnect}
	class="art-graph"
>
	<Background />
	<Controls />
</SvelteFlow>

<style>
	:global(.art-graph) {
		background: #1a1a1e;
		width: 100%;
		height: 100%;
	}

	:global(.art-graph .svelte-flow__node) {
		cursor: pointer;
		background: #2a2a2e;
		border: 2px solid #6366f1;
		border-radius: 8px;
		padding: 8px;
		font-size: 12px;
		color: #e0e0e0;
	}

	:global(.art-graph .svelte-flow__node.selected) {
		border-color: #10b981;
		box-shadow: 0 0 20px rgba(16, 185, 129, 0.5);
	}

	:global(.art-graph .svelte-flow__edge-path) {
		stroke: #6366f1;
		stroke-width: 2px;
	}

	:global(.art-graph .svelte-flow__edge.selected .svelte-flow__edge-path) {
		stroke: #10b981;
	}
</style>
