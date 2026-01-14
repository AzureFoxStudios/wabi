/**
 * Art-Specific Command Registry
 * Extends base CommandRegistry with /res command and resource-based queries
 */

import { get } from 'svelte/store';
import {
	resources,
	tags,
	searchResources,
	getResourcesByTag
} from '../business/store';
import type { CommandContext, CommandResult } from '../commands/CommandRegistry';

export interface ResourceNode {
	id: string;
	name: string;
	type: string;
	author?: string;
	isAnonymous?: boolean;
	preview?: string;
	tags: string[];
	thumbnail?: string;
}

export interface ArtCommandResult extends CommandResult {
	resourceNodes?: ResourceNode[];
	tagsFound?: string[];
}

/**
 * Parse art-specific command syntax
 * Supports:
 * - /res anatomy -chest -torso (tags starting with -)
 * - /res brush sakimi (text search)
 * - /res anatomy book (text search + tag)
 *
 * Returns parsed tags (prefixed with -) and search terms
 */
export function parseArtCommand(command: string): {
	searchTerms: string[];
	tags: string[];
} {
	const parts = command.trim().split(/\s+/);
	// Remove leading '/'
	const args = parts.length > 1 ? parts.slice(1) : [];

	const tags: string[] = [];
	const searchTerms: string[] = [];

	for (const arg of args) {
		if (arg.startsWith('-')) {
			// Tag flag: -chest, -torso
			const tag = arg.slice(1);
			if (tag) tags.push(tag);
		} else if (arg.length > 0) {
			// Search term
			searchTerms.push(arg);
		}
	}

	return { searchTerms, tags };
}

/**
 * Filter resources by role-based visibility
 */
function filterByRole(resourcesList: any[], userId: string | null): any[] {
	// For now, return all resources
	// Later: Check user roles against resource.minRole
	if (!userId) return resourcesList;

	return resourcesList.filter(r => {
		// If private and not owner, hide
		if (r.visibilityType === 'private' && r.createdBy !== userId) {
			return false;
		}
		// If personal and not owner, hide
		if (r.visibilityType === 'personal' && r.createdBy !== userId) {
			return false;
		}
		return true;
	});
}

/**
 * Execute /res command
 * Searches resources by tags and/or text
 */
export async function executeResCommand(
	args: string[],
	context: CommandContext
): Promise<ArtCommandResult> {
	// Parse flags and search terms
	const { searchTerms, tags } = parseArtCommand('/res ' + args.join(' '));

	// Get all resources
	let allResources = get(resources);

	// Apply tag filters
	if (tags.length > 0) {
		allResources = allResources.filter(r =>
			tags.every(tag => r.tags && r.tags.includes(tag))
		);
	}

	// Apply text search
	if (searchTerms.length > 0) {
		const query = searchTerms.join(' ').toLowerCase();
		allResources = allResources.filter(r =>
			r.name.toLowerCase().includes(query) ||
			(r.description && r.description.toLowerCase().includes(query))
		);
	}

	// Filter by role/visibility
	allResources = filterByRole(allResources, context.userId);

	// Transform to ResourceNode format
	const resourceNodes: ResourceNode[] = allResources.map(r => ({
		id: r.id,
		name: r.name,
		type: r.type,
		isAnonymous: r.isAnonymous,
		preview: r.preview,
		tags: r.tags || [],
		thumbnail: r.preview,
		author: r.isAnonymous ? undefined : r.createdBy
	}));

	if (resourceNodes.length === 0) {
		return {
			success: true,
			message: `No resources found matching: ${args.join(' ')}`,
			action: 'show-resource-links',
			resourceNodes: []
		};
	}

	// Format results
	const resultSummary =
		tags.length > 0 && searchTerms.length > 0
			? `Found ${resourceNodes.length} resources with tags [${tags.join(', ')}] matching "${searchTerms.join(' ')}"`
			: tags.length > 0
			? `Found ${resourceNodes.length} resources tagged with: ${tags.join(', ')}`
			: `Found ${resourceNodes.length} resources matching "${searchTerms.join(' ')}"`;

	return {
		success: true,
		message: resultSummary,
		data: {
			resourceNodes,
			tagsFound: tags
		},
		action: 'show-resource-links'
	};
}

/**
 * Auto-connect resources based on shared tags
 * Called when a resource is created or tags are updated
 */
export function autoConnectResources(resourceId: string, resourceTags: string[]): void {
	const allResources = get(resources);

	for (const tag of resourceTags) {
		// Find all resources with this tag
		const matchingResources = allResources.filter(
			r => r.id !== resourceId && r.tags && r.tags.includes(tag)
		);

		// Create edges would happen here
		// For now, console log for demo
		console.log(
			`Would connect resource ${resourceId} to ${matchingResources.length} resources via tag: ${tag}`
		);
	}
}

/**
 * Get resources grouped by tag for display
 */
export function getResourcesByTagGroup(): Map<string, any[]> {
	const allResources = get(resources);
	const grouped = new Map<string, any[]>();

	allResources.forEach(r => {
		if (!r.tags) return;

		r.tags.forEach(tag => {
			if (!grouped.has(tag)) {
				grouped.set(tag, []);
			}
			grouped.get(tag)!.push(r);
		});
	});

	return grouped;
}
