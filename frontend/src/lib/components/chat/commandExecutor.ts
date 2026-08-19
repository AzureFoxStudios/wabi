import type { Command } from '$lib/commands';

export function executeChatCommand(
	commandText: string,
	context: Record<string, any>
): boolean {
	const onExecuteCommand: ((cmd: string) => Promise<void>) | undefined = context.onExecuteCommand;
	const trimmed = commandText.trim();
	if (!trimmed.startsWith('/')) return false;
	const parts = trimmed.slice(1).split(/\s+/);
	const cmd = parts[0].toLowerCase();
	switch (cmd) {
		case 'pay':
		case 'payment': {
			const amount = parts[1] || '';
			const description = parts.slice(2).join(' ') || '';
			context.onOpenPaymentSheet?.({ amountInput: amount, description });
			return true;
		}
		default:
			if (onExecuteCommand) { void onExecuteCommand(trimmed); } else { console.warn("[Command] No onExecuteCommand handler"); }
			return true;
	}
}

export function getMatchingCommands(input: string): Command[] {
	if (!input.startsWith('/')) return [];
	const query = input.slice(1).toLowerCase();
	const allCommands: Command[] = [
		{ name: 'pay', description: 'Create a payment request', usage: '/pay <amount> [description]' },
		{ name: 'payment', description: 'Create a payment request', usage: '/payment <amount> [description]' },
		{ name: 'me', description: 'Send an emote message', usage: '/me <action>' },
		{ name: 'spoiler', description: 'Send a spoiler message', usage: '/spoiler <message>' }
	];
	return allCommands.filter((c) => c.name.startsWith(query));
}
