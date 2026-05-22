import type { Command } from '$lib/commands';

export function executeChatCommand(
	commandText: string,
	onExecuteCommand: (cmd: string) => Promise<void>,
	context: {
		onOpenPaymentSheet?: (prefill?: { amountInput?: string; description?: string; customerRef?: string }) => void;
		onOpenManualCash?: () => void;
	}
): boolean {
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
		case 'cash':
		case 'manual':
			context.onOpenManualCash?.();
			return true;
		default:
			void onExecuteCommand(trimmed);
			return true;
	}
}

export function getMatchingCommands(input: string): Command[] {
	if (!input.startsWith('/')) return [];
	const query = input.slice(1).toLowerCase();
	const allCommands: Command[] = [
		{ name: 'pay', description: 'Create a payment request' },
		{ name: 'payment', description: 'Create a payment request' },
		{ name: 'cash', description: 'Record manual cash trade' },
		{ name: 'manual', description: 'Record manual cash trade' },
		{ name: 'me', description: 'Send an emote message' },
		{ name: 'spoiler', description: 'Send a spoiler message' }
	];
	return allCommands.filter((c) => c.name.startsWith(query));
}
