import type { Resource, GraphEdge } from '$lib/business/store';

export interface Position {
	x: number;
	y: number;
}

/**
 * Community layout: Groups resources by tags in circular clusters
 */
export function computeCommunityLayout(
	resources: Resource[],
	tags: string[],
	centerX = 800,
	centerY = 600,
	clusterRadius = 500
): Map<string, Position> {
	const positions = new Map<string, Position>();

	// Get all unique tags
	const uniqueTags = Array.from(new Set(tags));
	if (uniqueTags.length === 0) {
		// Fallback: arrange in circle if no tags
		resources.forEach((resource, index) => {
			const angle = (index / resources.length) * 2 * Math.PI;
			const radius = 300;
			positions.set(resource.id, {
				x: centerX + Math.cos(angle) * radius,
				y: centerY + Math.sin(angle) * radius
			});
		});
		return positions;
	}

	// Create tag clusters in circular arrangement
	uniqueTags.forEach((tag, clusterIndex) => {
		const clusterAngle = (clusterIndex / uniqueTags.length) * 2 * Math.PI;
		const clusterCenterX = centerX + Math.cos(clusterAngle) * clusterRadius;
		const clusterCenterY = centerY + Math.sin(clusterAngle) * clusterRadius;

		// Find resources with this tag
		const taggedResources = resources.filter(r => r.tags && r.tags.includes(tag));

		// Arrange resources in circle around tag
		taggedResources.forEach((resource, resourceIndex) => {
			const angle = (resourceIndex / Math.max(taggedResources.length, 1)) * 2 * Math.PI;
			const resourceRadius = 80 + (taggedResources.length * 5);

			positions.set(resource.id, {
				x: clusterCenterX + Math.cos(angle) * resourceRadius,
				y: clusterCenterY + Math.sin(angle) * resourceRadius
			});
		});
	});

	// Also position tag nodes at cluster centers
	uniqueTags.forEach((tag, clusterIndex) => {
		const clusterAngle = (clusterIndex / uniqueTags.length) * 2 * Math.PI;
		const clusterCenterX = centerX + Math.cos(clusterAngle) * clusterRadius;
		const clusterCenterY = centerY + Math.sin(clusterAngle) * clusterRadius;
		positions.set(`tag-${tag}`, {
			x: clusterCenterX,
			y: clusterCenterY
		});
	});

	return positions;
}

/**
 * Radial/Mindmap layout: Central node with connections radiating outward
 */
export function computeRadialLayout(
	resources: Resource[],
	edges: GraphEdge[],
	centerResourceId: string | null = null,
	maxDepth = 3,
	centerX = 800,
	centerY = 600
): Map<string, Position> {
	const positions = new Map<string, Position>();

	if (resources.length === 0) return positions;

	// Use first resource as center if none specified
	const centerResource = centerResourceId
		? resources.find(r => r.id === centerResourceId)
		: resources[0];

	if (!centerResource) return positions;

	// Place center node
	positions.set(centerResource.id, { x: centerX, y: centerY });

	// Build adjacency map
	const adjacency = new Map<string, string[]>();
	resources.forEach(r => {
		adjacency.set(r.id, []);
	});
	edges.forEach(e => {
		adjacency.get(e.source)?.push(e.target);
		adjacency.get(e.target)?.push(e.source);
	});

	// BFS to arrange nodes by depth
	const visited = new Set<string>();
	const queue: Array<{ id: string; depth: number; angleRange: [number, number] }> = [
		{ id: centerResource.id, depth: 0, angleRange: [0, 2 * Math.PI] }
	];

	while (queue.length > 0) {
		const { id, depth, angleRange } = queue.shift()!;

		if (visited.has(id) || depth > maxDepth) continue;
		visited.add(id);

		const connected = adjacency.get(id) || [];
		const unvisited = connected.filter(n => !visited.has(n));

		if (unvisited.length === 0) continue;

		const angleStep = (angleRange[1] - angleRange[0]) / unvisited.length;

		unvisited.forEach((nodeId, index) => {
			const angle = angleRange[0] + (index + 0.5) * angleStep;
			const radius = (depth + 1) * 200;

			const node = resources.find(r => r.id === nodeId);
			if (node) {
				positions.set(nodeId, {
					x: centerX + Math.cos(angle) * radius,
					y: centerY + Math.sin(angle) * radius
				});

				queue.push({
					id: nodeId,
					depth: depth + 1,
					angleRange: [angleRange[0] + index * angleStep, angleRange[0] + (index + 1) * angleStep]
				});
			}
		});
	}

	// Position any unvisited nodes
	resources.forEach((resource, index) => {
		if (!positions.has(resource.id)) {
			const angle = (index / resources.length) * 2 * Math.PI;
			const radius = maxDepth * 200 + 100;
			positions.set(resource.id, {
				x: centerX + Math.cos(angle) * radius,
				y: centerY + Math.sin(angle) * radius
			});
		}
	});

	return positions;
}

/**
 * Force-directed layout: Physics-based node positioning
 */
export async function computeForceDirectedLayout(
	resources: Resource[],
	edges: GraphEdge[],
	iterations = 50,
	centerX = 800,
	centerY = 600
): Promise<Map<string, Position>> {
	const positions = new Map<string, Position>();
	const velocities = new Map<string, { x: number; y: number }>();

	// Initialize random positions
	resources.forEach(r => {
		positions.set(r.id, {
			x: centerX + (Math.random() - 0.5) * 400,
			y: centerY + (Math.random() - 0.5) * 400
		});
		velocities.set(r.id, { x: 0, y: 0 });
	});

	// Simulate physics
	for (let iter = 0; iter < iterations; iter++) {
		// Reset forces
		resources.forEach(r => {
			velocities.set(r.id, { x: 0, y: 0 });
		});

		// Repulsion: nodes push apart
		for (let i = 0; i < resources.length; i++) {
			for (let j = i + 1; j < resources.length; j++) {
				const a = resources[i];
				const b = resources[j];
				const posA = positions.get(a.id)!;
				const posB = positions.get(b.id)!;

				const dx = posA.x - posB.x;
				const dy = posA.y - posB.y;
				const dist = Math.sqrt(dx * dx + dy * dy) || 1;
				const repulsion = 20000 / (dist * dist);

				const velA = velocities.get(a.id)!;
				const velB = velocities.get(b.id)!;

				velA.x += (dx / dist) * repulsion;
				velA.y += (dy / dist) * repulsion;
				velB.x -= (dx / dist) * repulsion;
				velB.y -= (dy / dist) * repulsion;
			}
		}

		// Attraction: edges pull together
		edges.forEach(edge => {
			const posA = positions.get(edge.source);
			const posB = positions.get(edge.target);

			if (posA && posB) {
				const dx = posB.x - posA.x;
				const dy = posB.y - posA.y;
				const dist = Math.sqrt(dx * dx + dy * dy) || 1;
				const attraction = (dist * dist) / 150;

				const velA = velocities.get(edge.source)!;
				const velB = velocities.get(edge.target)!;

				velA.x += (dx / dist) * attraction;
				velA.y += (dy / dist) * attraction;
				velB.x -= (dx / dist) * attraction;
				velB.y -= (dy / dist) * attraction;
			}
		});

		// Update positions with damping
		resources.forEach(r => {
			const pos = positions.get(r.id)!;
			const vel = velocities.get(r.id)!;

			pos.x += vel.x * 0.02;
			pos.y += vel.y * 0.02;

			// Keep nodes within bounds
			pos.x = Math.max(100, Math.min(pos.x, 1500));
			pos.y = Math.max(100, Math.min(pos.y, 1100));
		});
	}

	return positions;
}

/**
 * Timeline layout: Arrange by creation date in spiral
 */
export function computeTimelineLayout(
	resources: Resource[],
	centerX = 800,
	centerY = 600
): Map<string, Position> {
	const positions = new Map<string, Position>();

	// Sort by creation date
	const sorted = [...resources].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

	// Arrange in spiral timeline
	sorted.forEach((resource, index) => {
		const angle = index * 0.3; // Increment angle
		const radius = 150 + (index * 15); // Expand outward

		positions.set(resource.id, {
			x: centerX + Math.cos(angle) * radius,
			y: centerY + Math.sin(angle) * radius
		});
	});

	return positions;
}
