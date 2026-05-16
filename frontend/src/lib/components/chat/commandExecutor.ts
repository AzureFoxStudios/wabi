import { deleteDictionaryEntry, lookupDictionary, upsertDictionaryEntry } from '$lib/api';
import { getAuthToken } from '$lib/authSession';
import { resources } from '$lib/business/store';
import type { CalendarEvent, DiaryEntry, Project, Resource, Todo } from '$lib/business/types';
import { formatCommandHelp, parseCommand } from '$lib/commands';
import { findDmDirectoryUserByUsername, getDmDirectoryKey } from '$lib/dmUserDirectory';
import type { Channel, User } from '$lib/socket';

type SendMessage = (
	channelId: string,
	text: string,
	messageType: string,
	options?: Record<string, unknown>
) => void;

type PaymentSheetPrefill = {
	amountInput?: string | null;
	description?: string | null;
	customerRef?: string | null;
};

export type ExecuteChatCommandContext = {
	currentChannel: string;
	currentUser: User | null;
	users: User[];
	serverMembers: User[];
	channels: Channel[];
	todos: Todo[];
	calendarEvents: CalendarEvent[];
	diaryEntries: DiaryEntry[];
	projects: Project[];
	currentLocale?: string | null;
	paymentButtonEnabled: boolean;
	sendMessage: SendMessage;
	pinChannel: (channelId: string) => void;
	unpinChannel: (channelId: string) => void;
	setSearchInput: (value: string) => void;
	openReaderSurface: () => void;
	openModelViewportSurface: () => void;
	openFullMapTab: () => unknown;
	openPaymentSheet: (prefill?: PaymentSheetPrefill) => void;
	dispatchLogout: () => void;
	createDM: (directoryKey: string) => void;
	getDMChannelIdForUser: (currentUser: User | null, targetUser: User) => string;
	openExistingDM: (channelId: string, otherUser: User) => void;
	pushLocalDirectionsCard: (channelId: string, rawTarget: string) => Promise<boolean>;
	navigateTo: (path: string) => void;
};

function normalizePayAmountInput(rawAmount: string): string | null {
	const cleaned = rawAmount.replace(/,/g, '').replace(/^\$/, '').trim();
	if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
	const parsedAmount = Number.parseFloat(cleaned);
	if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) return null;
	return parsedAmount.toFixed(2);
}

function resolvePayTargetUser(identifier: string, users: User[]): User | null {
	const normalized = identifier.trim().replace(/^@+/, '').toLowerCase();
	if (!normalized) return null;
	return users.find((candidate) => candidate.username.toLowerCase() === normalized) || null;
}

function parseWordCommandPayload(
	rawInput: string,
	currentLocale?: string | null
): {
	action: 'add' | 'view' | 'remove' | 'help';
	term?: string;
	definition?: string;
	language?: string;
} {
	const withoutPrefix = rawInput.trim().replace(/^\/word\s*/i, '');
	if (!withoutPrefix) {
		return { action: 'help' };
	}
	const firstSpace = withoutPrefix.indexOf(' ');
	const actionRaw = (firstSpace >= 0 ? withoutPrefix.slice(0, firstSpace) : withoutPrefix).trim().toLowerCase();
	const rest = firstSpace >= 0 ? withoutPrefix.slice(firstSpace + 1).trim() : '';
	const action = actionRaw === 'add' || actionRaw === 'view' || actionRaw === 'remove' ? actionRaw : 'help';
	if (action === 'help') return { action: 'help' };

	if (action === 'add') {
		const parts = rest.split('|').map((part) => part.trim()).filter(Boolean);
		return {
			action,
			term: parts[0],
			definition: parts[1],
			language: (parts[2] || currentLocale || 'en').toLowerCase()
		};
	}

	const parts = rest.split('|').map((part) => part.trim()).filter(Boolean);
	return {
		action,
		term: parts[0],
		language: (parts[1] || currentLocale || 'en').toLowerCase()
	};
}

function getWordCommandHelp(): string {
	return [
		'Word Dictionary Commands:',
		'',
		'/word add <term> | <definition> | [language]',
		'Example: /word add がんばって | to cheer / do your best | ja',
		'',
		'/word view <term> | [language]',
		'Example: /word view がんばって | ja',
		'',
		'/word remove <term> | [language]'
	].join('\n');
}

export async function executeChatCommand(
	commandInput: string,
	context: ExecuteChatCommandContext
): Promise<void> {
	const parsed = parseCommand(commandInput);

	if (parsed.error) {
		console.warn(parsed.error);
		return;
	}

	if (!parsed.command) return;

	const commandName = parsed.command.name;

	switch (commandName) {
		case 'help':
		case 'h':
		case '?':
			alert(`Available Commands:\n\n${formatCommandHelp()}`);
			break;

		case 'resource':
		case 'res':
		case 'r': {
			const resourceName = parsed.args.join(' ');
			if (!resourceName) {
				alert('Resource name is required.\nUsage: /resource <name> [-a] [-tag tagname]');
				return;
			}

			const tag = typeof parsed.flags['tag'] === 'string' ? parsed.flags['tag'] : undefined;
			const newResource: Resource = {
				id: `res-${Date.now()}`,
				name: resourceName,
				type: 'note',
				storageType: 'inline',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				createdBy: parsed.flags['a'] ? 'Anonymous' : (context.currentUser?.username || 'Unknown'),
				isAnonymous: !!parsed.flags['a'],
				visibilityType: 'public',
				tags: tag ? [tag] : []
			};

			resources.update((items) => [...items, newResource]);
			alert(`Resource "${resourceName}" created!`);
			break;
		}

		case 'search':
		case 's': {
			const searchTerm = parsed.args.join(' ');
			if (!searchTerm) {
				alert('Search term is required.\nUsage: /search <term> [-by username] [-has image|video|file|link]');
				return;
			}
			let nextSearchInput = searchTerm;
			if (parsed.flags['by']) {
				nextSearchInput += ` by:${parsed.flags['by']}`;
			}
			if (parsed.flags['has']) {
				nextSearchInput += ` has:${parsed.flags['has']}`;
			}
			context.setSearchInput(nextSearchInput);
			break;
		}

		case 'pin':
		case 'p': {
			let targetChannelId = context.currentChannel;
			if (parsed.args.length > 0) {
				const channelName = parsed.args.join(' ');
				const targetChannel = context.channels.find(
					(channel) => channel.name.toLowerCase() === channelName.toLowerCase()
				);
				if (!targetChannel) {
					alert(`Channel "${channelName}" not found!`);
					return;
				}
				targetChannelId = targetChannel.id;
			}
			context.pinChannel(targetChannelId);
			const channelName = context.channels.find((channel) => channel.id === targetChannelId)?.name || 'Channel';
			alert(`"${channelName}" pinned!`);
			break;
		}

		case 'unpin':
		case 'up': {
			let targetChannelId = context.currentChannel;
			if (parsed.args.length > 0) {
				const channelName = parsed.args.join(' ');
				const targetChannel = context.channels.find(
					(channel) => channel.name.toLowerCase() === channelName.toLowerCase()
				);
				if (!targetChannel) {
					alert(`Channel "${channelName}" not found!`);
					return;
				}
				targetChannelId = targetChannel.id;
			}
			context.unpinChannel(targetChannelId);
			const channelName = context.channels.find((channel) => channel.id === targetChannelId)?.name || 'Channel';
			alert(`"${channelName}" unpinned!`);
			break;
		}

		case 'todo':
		case 'todos':
		case 'tasks': {
			const todoList = context.todos;
			if (todoList.length === 0) {
				alert('No todos yet!');
				return;
			}

			const isOpen = !!parsed.flags['open'];
			const todoText = todoList
				.map((todo, index) => `${index + 1}. ${todo.status === 'done' ? 'DONE' : 'OPEN'} ${todo.title}`)
				.join('\n');

			const message = `My Todos${isOpen ? ' (Shared)' : ''}:\n\`\`\`\n${todoText}\n\`\`\``;

			if (isOpen) {
				context.sendMessage(context.currentChannel, message, 'text', {});
			} else {
				alert(`My Todos:\n\n${todoText}`);
			}
			break;
		}

		case 'calendar':
		case 'cal':
		case 'events': {
			const now = Date.now();
			const upcoming = context.calendarEvents
				.filter((event) => event.startDate >= now)
				.sort((a, b) => a.startDate - b.startDate)
				.slice(0, 10);

			if (upcoming.length === 0) {
				alert('No upcoming events!');
				return;
			}

			const isOpen = !!parsed.flags['open'];
			const eventText = upcoming
				.map((event) => {
					const date = new Date(event.startDate).toLocaleDateString();
					return `${event.title} - ${date}`;
				})
				.join('\n');

			const message = `Upcoming Events${isOpen ? ' (Shared)' : ''}:\n\`\`\`\n${eventText}\n\`\`\``;

			if (isOpen) {
				context.sendMessage(context.currentChannel, message, 'text', {});
			} else {
				alert(`Upcoming Events:\n\n${eventText}`);
			}
			break;
		}

		case 'journal':
		case 'j':
		case 'diary': {
			const entries = context.diaryEntries.slice(0, 5);

			if (entries.length === 0) {
				alert('No journal entries yet!');
				return;
			}

			const isOpen = !!parsed.flags['open'];
			const entryText = entries
				.map((entry) => {
					const date = new Date(entry.createdAt).toLocaleDateString();
					return `${date}: ${entry.content.substring(0, 100)}...`;
				})
				.join('\n');

			const message = `Recent Journal Entries${isOpen ? ' (Shared)' : ''}:\n\`\`\`\n${entryText}\n\`\`\``;

			if (isOpen) {
				context.sendMessage(context.currentChannel, message, 'text', {});
			} else {
				alert(`Recent Journal Entries:\n\n${entryText}`);
			}
			break;
		}

		case 'projects':
		case 'proj': {
			const projectList = context.projects;

			if (projectList.length === 0) {
				alert('No projects yet!');
				return;
			}

			const isOpen = !!parsed.flags['open'];
			const projText = projectList
				.map((project) => `${project.name} - ${project.status}`)
				.join('\n');

			const message = `My Projects${isOpen ? ' (Shared)' : ''}:\n\`\`\`\n${projText}\n\`\`\``;

			if (isOpen) {
				context.sendMessage(context.currentChannel, message, 'text', {});
			} else {
				alert(`My Projects:\n\n${projText}`);
			}
			break;
		}

		case 'art':
		case 'a':
		case 'graph':
		case 'resources': {
			context.navigateTo('/art');
			break;
		}

		case 'business':
		case 'b':
		case 'hub':
		case 'tasks': {
			context.navigateTo('/business');
			break;
		}

		case 'mainchat':
		case 'main':
		case 'chat':
		case 'home': {
			context.navigateTo('/');
			break;
		}

		case 'read': {
			context.openReaderSurface();
			break;
		}

		case '3d': {
			context.openModelViewportSurface();
			break;
		}

		case 'map':
		case 'maps': {
			void context.openFullMapTab();
			break;
		}

		case 'dm':
		case 'message':
		case 'msg': {
			const username = parsed.args.join(' ');
			if (!username) {
				alert('Please specify a username.\nUsage: /dm <username>');
				return;
			}

			const targetUser = findDmDirectoryUserByUsername({
				username,
				onlineUsers: context.users,
				serverMembers: context.serverMembers,
				currentUser: context.currentUser
			});

			if (!targetUser) {
				alert(`User "${username}" not found.`);
				return;
			}

			const dmId = context.getDMChannelIdForUser(context.currentUser, targetUser);
			const existingDM = context.channels.find((channel) => channel.id === dmId);

			if (existingDM) {
				context.openExistingDM(dmId, targetUser);
			} else {
				context.createDM(getDmDirectoryKey(targetUser));
			}
			break;
		}

		case 'pay': {
			if (!context.paymentButtonEnabled) {
				alert('Sign in with a registered account to create payments.');
				break;
			}

			const userFlagValue =
				typeof parsed.flags['user'] === 'string'
					? parsed.flags['user']
					: typeof parsed.flags['u'] === 'string'
						? parsed.flags['u']
						: '';
			const amountFlagValue =
				typeof parsed.flags['amt'] === 'string'
					? parsed.flags['amt']
					: typeof parsed.flags['amount'] === 'string'
						? parsed.flags['amount']
						: '';

			let requestedUser = userFlagValue.trim();
			let requestedAmount = amountFlagValue.trim();

			for (const arg of parsed.args) {
				const amountCandidate = normalizePayAmountInput(arg);
				if (!requestedAmount && amountCandidate) {
					requestedAmount = amountCandidate;
					continue;
				}
				if (!requestedUser) {
					requestedUser = arg;
				}
			}

			const normalizedAmount = requestedAmount ? normalizePayAmountInput(requestedAmount) : null;
			if (requestedAmount && !normalizedAmount) {
				alert('Invalid amount.\nUsage: /pay [@username] [amount] [-user username] [-amt 12.34]');
				break;
			}

			let targetUser: User | null = null;
			if (requestedUser) {
				targetUser = resolvePayTargetUser(requestedUser, context.users);
				if (!targetUser) {
					alert(`User "${requestedUser}" not found.\nUsage: /pay [@username] [amount]`);
					break;
				}
			}

			context.openPaymentSheet({
				amountInput: normalizedAmount,
				description: targetUser ? `Payment request for @${targetUser.username}` : '',
				customerRef: ''
			});
			break;
		}

		case 'logout':
		case 'signout':
		case 'exit': {
			context.dispatchLogout();
			break;
		}

		case 'word':
		case 'dict':
		case 'dictionary': {
			const payload = parseWordCommandPayload(commandInput, context.currentLocale);
			if (payload.action === 'help' || !payload.term) {
				alert(getWordCommandHelp());
				break;
			}

			if (payload.action === 'view') {
				try {
					const entries = await lookupDictionary(payload.term, payload.language || 'en', 5);
					if (entries.length === 0) {
						alert(`No dictionary entry found for "${payload.term}" (${payload.language || 'en'}).`);
						break;
					}
					const lines = entries.map((entry, index) => {
						const editor = entry.createdByUsername ? ` (by ${entry.createdByUsername})` : '';
						return `${index + 1}. ${entry.term} [${entry.language}] -> ${entry.definition}${editor}`;
					});
					alert(lines.join('\n'));
				} catch (error) {
					alert(error instanceof Error ? error.message : 'Failed to lookup dictionary entry.');
				}
				break;
			}

			if (payload.action === 'add') {
				if (!payload.definition) {
					alert(getWordCommandHelp());
					break;
				}
				const authToken = getAuthToken();
				if (!authToken) {
					alert('Login is required to add dictionary entries.');
					break;
				}
				try {
					const saved = await upsertDictionaryEntry(
						authToken,
						payload.term,
						payload.definition,
						payload.language || 'en'
					);
					alert(`Saved: ${saved.term} [${saved.language}] -> ${saved.definition}`);
				} catch (error) {
					alert(error instanceof Error ? error.message : 'Failed to save dictionary entry.');
				}
				break;
			}

			if (payload.action === 'remove') {
				const authToken = getAuthToken();
				if (!authToken) {
					alert('Login is required to remove dictionary entries.');
					break;
				}
				try {
					await deleteDictionaryEntry(authToken, payload.term, payload.language || 'en');
					alert(`Removed dictionary entry for "${payload.term}" (${payload.language || 'en'}).`);
				} catch (error) {
					alert(error instanceof Error ? error.message : 'Failed to remove dictionary entry.');
				}
			}
			break;
		}

		case 'directions':
		case 'dir':
		case 'where': {
			const rawTarget = parsed.args.join(' ').trim();
			if (!rawTarget) {
				alert('Place is required.\nUsage: /directions <@place|place-slug[/poi]>');
				break;
			}
			if (!(await context.pushLocalDirectionsCard(context.currentChannel, rawTarget))) {
				alert(`Place "${rawTarget}" was not found.`);
			}
			break;
		}

		default:
			console.warn(`Unknown command: ${commandName}`);
	}
}
