/**
 * Command Registry - Handles slash commands in chat
 * Provides a simple command parser and execution system
 */

import { get } from 'svelte/store';
import {
	resources,
	tags,
	graphEdges,
	addResource,
	deleteResource,
	searchResources,
	getResourcesByTag,
	addTag,
	deleteTag,
	getTag,
	addGraphEdge,
	deleteGraphEdge,
	generateId
} from '../business/store';

export interface CommandContext {
	userId: string;
	channelId: string;
	workspaceId: string;
	messageInput: string;
}

export interface CommandResult {
	success: boolean;
	message?: string;
	data?: any;
	action?: 'navigate' | 'open-modal' | 'insert-text' | 'send-message' | 'clear-channel';
}

type CommandHandler = (args: string[], context: CommandContext) => Promise<CommandResult>;

const commandHandlers: Map<string, CommandHandler> = new Map();

/**
 * Register a new command
 */
export function registerCommand(name: string, handler: CommandHandler): void {
	commandHandlers.set(name, handler);
}

/**
 * Execute a command string (e.g., "/resource list brushes")
 */
export async function executeCommand(input: string, context: CommandContext): Promise<CommandResult> {
	const trimmed = input.trim();
	if (!trimmed.startsWith('/')) {
		return { success: false, message: 'Not a command' };
	}

	const parts = trimmed.slice(1).split(/\s+/);
	const commandName = parts[0];
	const args = parts.slice(1);

	const handler = commandHandlers.get(commandName);
	if (!handler) {
		return { success: false, message: `Unknown command: /${commandName}` };
	}

	try {
		return await handler(args, context);
	} catch (error) {
		console.error(`Error executing command /${commandName}:`, error);
		return {
			success: false,
			message: `Error executing command: ${error instanceof Error ? error.message : 'Unknown error'}`
		};
	}
}

/**
 * Built-in command handlers
 */

// /resource list [type] - List all resources or by type
registerCommand('resource', async (args, context) => {
	if (args.length === 0) {
		return { success: false, message: 'Usage: /resource <list|create|search> [args]' };
	}

	const action = args[0];

	if (action === 'list') {
		const type = args[1];
		const allResources = get(resources);
		const filtered = type ? allResources.filter(r => r.type === type) : allResources;

		if (filtered.length === 0) {
			return { success: true, message: 'No resources found' };
		}

		const list = filtered.map(r => `• ${r.name} (${r.type})`).join('\n');
		return {
			success: true,
			message: `Found ${filtered.length} resource(s):\n${list}`,
			action: 'send-message'
		};
	}

	if (action === 'create') {
		const name = args.slice(1).join(' ');
		if (!name) {
			return { success: false, message: 'Usage: /resource create <name>' };
		}

		const newResource = addResource({
			type: 'note',
			name,
			description: '',
			storageType: 'inline',
			content: '',
			tags: [],
			createdBy: context.userId
		});

		return {
			success: true,
			message: `Created resource: ${name}`,
			data: newResource,
			action: 'send-message'
		};
	}

	if (action === 'search') {
		const query = args.slice(1).join(' ');
		if (!query) {
			return { success: false, message: 'Usage: /resource search <query>' };
		}

		const found = searchResources(query);
		if (found.length === 0) {
			return { success: true, message: `No resources match "${query}"`, action: 'send-message' };
		}

		const list = found.map(r => `• ${r.name} (${r.type})`).join('\n');
		return {
			success: true,
			message: `Found ${found.length} resource(s) matching "${query}":\n${list}`,
			data: found,
			action: 'send-message'
		};
	}

	return { success: false, message: 'Unknown resource action. Use: list, create, or search' };
});

// /graph [filter] - Open knowledge graph view
registerCommand('graph', async (args, context) => {
	const filter = args.join(' ') || '';

	return {
		success: true,
		message: filter ? `Opening graph filtered by: ${filter}` : 'Opening knowledge graph',
		data: { filter },
		action: 'navigate'
	};
});

// /tag list - List all tags
registerCommand('tag', async (args, context) => {
	if (args.length === 0) {
		return { success: false, message: 'Usage: /tag <list|create|add|remove> [args]' };
	}

	const action = args[0];

	if (action === 'list') {
		const allTags = get(tags);
		if (allTags.length === 0) {
			return { success: true, message: 'No tags created yet', action: 'send-message' };
		}

		const list = allTags.map(t => `• ${t.name}`).join('\n');
		return {
			success: true,
			message: `Available tags:\n${list}`,
			action: 'send-message'
		};
	}

	if (action === 'create') {
		const name = args[1];
		const color = args[2] || '#64748b';

		if (!name) {
			return { success: false, message: 'Usage: /tag create <name> [color]' };
		}

		const newTag = addTag({
			name,
			color
		});

		return {
			success: true,
			message: `Created tag: ${name}`,
			data: newTag,
			action: 'send-message'
		};
	}

	return { success: false, message: 'Unknown tag action. Use: list or create' };
});

// /todo <text> - Quick todo creation (links to business hub later)
registerCommand('todo', async (args, context) => {
	const text = args.join(' ');
	if (!text) {
		return { success: false, message: 'Usage: /todo <task description>' };
	}

	return {
		success: true,
		message: `📝 Todo created: ${text}`,
		data: { text, userId: context.userId },
		action: 'send-message'
	};
});

// /search <query> - Search across all resources
registerCommand('search', async (args, context) => {
	const query = args.join(' ');
	if (!query) {
		return { success: false, message: 'Usage: /search <query>' };
	}

	const found = searchResources(query);

	if (found.length === 0) {
		return {
			success: true,
			message: `No results found for "${query}"`,
			action: 'send-message'
		};
	}

	const list = found
		.map(r => `• **${r.name}** (${r.type})${r.description ? '\n  ' + r.description : ''}`)
		.join('\n');

	return {
		success: true,
		message: `Found ${found.length} result(s) for "${query}":\n${list}`,
		data: found,
		action: 'send-message'
	};
});

// /help - Show available commands
registerCommand('help', async (args, context) => {
	const commands = Array.from(commandHandlers.keys());
	const help = `
Available commands:
• /resource list [type] - List resources (optionally by type)
• /resource create <name> - Create a new resource
• /resource search <query> - Search resources
• /graph [filter] - Open knowledge graph
• /tag list - List all tags
• /tag create <name> [color] - Create a new tag
• /todo <text> - Create a quick todo
• /search <query> - Search everything
• /business - Open business hub (Ctrl+Shift+1)
• /me <action> - Send action message
• /shrug - Append ¯\\_(ツ)_/¯ to message
• /tableflip - Append (╯°□°)╯︵ ┻━┻ to message
• /help - Show this help message
`;

	return {
		success: true,
		message: help,
		action: 'send-message'
	};
});

// /clear - Clear channel messages (client-side only)
registerCommand('clear', async (args, context) => {
	return {
		success: true,
		message: 'Cleared channel messages',
		action: 'clear-channel'
	};
});

// /me <action> - Send action message
registerCommand('me', async (args, context) => {
	const action = args.join(' ');
	if (!action) {
		return { success: false, message: 'Usage: /me <action>' };
	}

	return {
		success: true,
		message: `_${action}_`,
		action: 'send-message'
	};
});

// /shrug - Append shrug emoji
registerCommand('shrug', async (args, context) => {
	const text = args.join(' ');
	return {
		success: true,
		message: `${text} ¯\\_(ツ)_/¯`,
		action: 'send-message'
	};
});

// /tableflip - Append table flip emoji
registerCommand('tableflip', async (args, context) => {
	const text = args.join(' ');
	return {
		success: true,
		message: `${text} (╯°□°)╯︵ ┻━┻`,
		action: 'send-message'
	};
});

// /business - Open business hub
registerCommand('business', async (args, context) => {
	return {
		success: true,
		message: 'Opening business hub...',
		action: 'navigate',
		data: { path: '/business' }
	};
});
