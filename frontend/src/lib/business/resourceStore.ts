import { get } from 'svelte/store';
import type { Resource, Tag, GraphEdge } from './types';
import { resources, tags, graphEdges } from './state';
import { generateId } from './utils';

export function addResource(resource: Omit<Resource, 'id' | 'createdAt' | 'updatedAt'>): Resource {
	const newResource: Resource = {
		...resource,
		id: generateId(),
		createdAt: Date.now(),
		updatedAt: Date.now()
	};
	resources.update(r => [...r, newResource]);
	return newResource;
}

export function updateResource(id: string, updates: Partial<Resource>): void {
	resources.update(r =>
		r.map(resource =>
			resource.id === id
				? { ...resource, ...updates, updatedAt: Date.now() }
				: resource
		)
	);
}

export function deleteResource(id: string): void {
	resources.update(r => r.filter(resource => resource.id !== id));
}

export function getResource(id: string): Resource | undefined {
	return get(resources).find(r => r.id === id);
}

export function addTag(tag: Omit<Tag, 'id'>): Tag {
	const newTag: Tag = { ...tag, id: generateId() };
	tags.update(t => [...t, newTag]);
	return newTag;
}

export function updateTag(id: string, updates: Partial<Tag>): void {
	tags.update(t => t.map(tag => tag.id === id ? { ...tag, ...updates } : tag));
}

export function deleteTag(id: string): void {
	tags.update(t => t.filter(tag => tag.id !== id));
}

export function getTag(id: string): Tag | undefined {
	return get(tags).find(t => t.id === id);
}

export function addGraphEdge(edge: Omit<GraphEdge, 'id'>): GraphEdge {
	const newEdge: GraphEdge = { ...edge, id: generateId() };
	graphEdges.update(e => [...e, newEdge]);
	return newEdge;
}

export function updateGraphEdge(id: string, updates: Partial<GraphEdge>): void {
	graphEdges.update(e => e.map(edge => edge.id === id ? { ...edge, ...updates } : edge));
}

export function deleteGraphEdge(id: string): void {
	graphEdges.update(e => e.filter(edge => edge.id !== id));
}

export function getGraphEdge(id: string): GraphEdge | undefined {
	return get(graphEdges).find(e => e.id === id);
}

export function getConnectedEdges(nodeId: string): GraphEdge[] {
	return get(graphEdges).filter(e => e.source === nodeId || e.target === nodeId);
}

export function getResourcesByTag(tagId: string): Resource[] {
	return get(resources).filter(r => r.tags.includes(tagId));
}

export function searchResources(query: string): Resource[] {
	const lowerQuery = query.toLowerCase();
	return get(resources).filter(r =>
		r.name.toLowerCase().includes(lowerQuery) ||
		r.description?.toLowerCase().includes(lowerQuery)
	);
}
