export interface Command {
	name: string;
	description: string;
	usage: string;
	aliases?: string[];
	execute?: (args: string[], flags: Record<string, boolean | string>) => void;
}

export const COMMANDS: Command[] = [
	{
		name: 'help',
		description: 'Show all available commands',
		usage: '/help',
		aliases: ['h', '?']
	},
	{
		name: 'resource',
		description: 'Create a new resource in the Art Graph',
		usage: '/resource <name> [-a] [-tag tagname]',
		aliases: ['res', 'r'],
		execute: (args, flags) => {
			// Implementation in Chat component
		}
	},
	{
		name: 'search',
		description: 'Search messages in current channel',
		usage: '/search <term> [-by username] [-has image|video|file|link]',
		aliases: ['s'],
		execute: (args, flags) => {
			// Implementation in Chat component
		}
	},
	{
		name: 'pin',
		description: 'Pin a channel (or current channel if no name given)',
		usage: '/pin [channelName]',
		aliases: ['p']
	},
	{
		name: 'unpin',
		description: 'Unpin a channel (or current channel if no name given)',
		usage: '/unpin [channelName]',
		aliases: ['up']
	},
	{
		name: 'todo',
		description: 'Show all todos (business hub data)',
		usage: '/todo [-open]',
		aliases: ['todos', 'tasks'],
		execute: (args, flags) => {
			// Implementation in Chat component
		}
	},
	{
		name: 'calendar',
		description: 'Show upcoming calendar events',
		usage: '/calendar [-open]',
		aliases: ['cal', 'events'],
		execute: (args, flags) => {
			// Implementation in Chat component
		}
	},
	{
		name: 'journal',
		description: 'Show recent journal entries',
		usage: '/journal [-open]',
		aliases: ['j', 'diary'],
		execute: (args, flags) => {
			// Implementation in Chat component
		}
	},
	{
		name: 'projects',
		description: 'Show all projects',
		usage: '/projects [-open]',
		aliases: ['proj', 'p'],
		execute: (args, flags) => {
			// Implementation in Chat component
		}
	},
	{
		name: 'art',
		description: 'Navigate to the Art/Knowledge Graph portal',
		usage: '/art',
		aliases: ['a', 'graph', 'resources'],
		execute: (args, flags) => {
			// Implementation in Chat component
		}
	},
	{
		name: 'business',
		description: 'Navigate to the Business Hub (Calendar, Journal, Projects)',
		usage: '/business',
		aliases: ['b', 'hub', 'tasks'],
		execute: (args, flags) => {
			// Implementation in Chat component
		}
	},
	{
		name: 'mainchat',
		description: 'Return to the main Wabi Chat',
		usage: '/mainchat',
		aliases: ['main', 'chat', 'home'],
		execute: (args, flags) => {
			// Implementation in Chat component
		}
	},
	{
		name: 'read',
		description: 'Open Reader Mode for long-form reading surfaces',
		usage: '/read',
		aliases: ['reader', 'book'],
		execute: (args, flags) => {
			// Implementation in Chat component
		}
	},
	{
		name: '3d',
		description: 'Open the full-screen 3D model viewer surface',
		usage: '/3d',
		aliases: ['model', 'viewport'],
		execute: (args, flags) => {
			// Implementation in Chat component
		}
	},
	{
		name: 'map',
		description: 'Open the full-screen map surface',
		usage: '/map',
		aliases: ['maps'],
		execute: (args, flags) => {
			// Implementation in Chat component
		}
	},
	{
		name: 'dm',
		description: 'Open a direct message with a user',
		usage: '/dm <username>',
		aliases: ['message', 'msg'],
		execute: (args, flags) => {
			// Implementation in Chat component
		}
	},
	{
		name: 'pay',
		description: 'Open payment sheet with optional user/amount prefill',
		usage: '/pay [@username] [amount] [-user username] [-amt 12.34]',
		aliases: ['payment'],
		execute: (args, flags) => {
			// Implementation in Chat component
		}
	},
	{
		name: 'logout',
		description: 'Log out of the chat and clear session data',
		usage: '/logout',
		aliases: ['signout', 'exit'],
		execute: (args, flags) => {
			// Implementation in Chat component
		}
	},
	{
		name: 'word',
		description: 'Community dictionary tools (add/view/remove)',
		usage: '/word add <term> | <definition> | [language]',
		aliases: ['dict', 'dictionary'],
		execute: (args, flags) => {
			// Implementation in Chat component
		}
	},
	{
		name: 'directions',
		description: 'Show a local-only directions card for a place or POI',
		usage: '/directions <@place|place-slug[/poi]>',
		aliases: ['dir', 'where'],
		execute: (args, flags) => {
			// Implementation in Chat component
		}
	},
	{
		// N1: open floating QuickScratchpad (store side-effect; no Chat handler needed)
		name: 'scratch',
		description: 'Open the quick scratchpad (Ctrl/Cmd+Shift+N)',
		usage: '/scratch',
		aliases: ['scratchpad', 'pad'],
		execute: () => {
			// Lazy import avoids circular deps with notesStore consumers
			import('$lib/notesStore').then(({ openQuickScratchpad }) => {
				openQuickScratchpad();
			});
		}
	}
];

export interface ParsedCommand {
	command: Command | null;
	args: string[];
	flags: Record<string, boolean | string>;
	raw: string;
	error?: string;
}

export function parseCommand(input: string): ParsedCommand {
	const trimmed = input.trim();

	// Check if it starts with /
	if (!trimmed.startsWith('/')) {
		return {
			command: null,
			args: [],
			flags: {},
			raw: input,
			error: 'Not a command'
		};
	}

	// Remove leading /
	const parts = trimmed.slice(1).split(/\s+/);
	const commandName = parts[0].toLowerCase();
	const restArgs = parts.slice(1);

	// Find matching command by name or alias
	let command = COMMANDS.find(c => c.name === commandName);
	if (!command) {
		command = COMMANDS.find(c => c.aliases?.includes(commandName));
	}

	if (!command) {
		return {
			command: null,
			args: [],
			flags: {},
			raw: input,
			error: `Unknown command: /${commandName}`
		};
	}

	// Parse args and flags
	const args: string[] = [];
	const flags: Record<string, boolean | string> = {};

	for (let i = 0; i < restArgs.length; i++) {
		const arg = restArgs[i];

		if (arg.startsWith('-')) {
			// It's a flag
			const flagName = arg.slice(1).toLowerCase();
			const nextArg = restArgs[i + 1];

			// Check if next arg is a value for this flag (doesn't start with -)
			if (nextArg && !nextArg.startsWith('-')) {
				flags[flagName] = nextArg;
				i++; // Skip next arg since we used it as value
			} else {
				flags[flagName] = true;
			}
		} else {
			// It's a regular argument
			args.push(arg);
		}
	}

	return {
		command,
		args,
		flags,
		raw: input
	};
}

export function getMatchingCommands(input: string): Command[] {
	if (!input.startsWith('/')) return [];

	const commandName = input.slice(1).toLowerCase();
	return COMMANDS.filter(
		cmd =>
			cmd.name.startsWith(commandName) ||
			cmd.aliases?.some(alias => alias.startsWith(commandName))
	);
}

export function formatCommandHelp(): string {
	return COMMANDS.map(cmd => {
		const aliases = cmd.aliases?.length ? ` (${cmd.aliases.join(', ')})` : '';
		return `/${cmd.name}${aliases}\n  ${cmd.description}\n  Usage: ${cmd.usage}`;
	}).join('\n\n');
}
