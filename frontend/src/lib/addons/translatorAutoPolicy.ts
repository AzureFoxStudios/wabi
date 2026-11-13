/**
 * Whether MessageItem may auto-translate a visible message, kept out of the component so the
 * rule is tested without a DOM. 'kept': the message or its room keeps content on the device
 * (privacy/contentEgress.ts), and its text never goes to the translation service automatically.
 */
export type AutoTranslationSkip = 'kept' | 'not-visible' | 'manual' | 'own' | 'mode' | 'type' | 'local' | null;

export function autoTranslationSkip(input: {
	visible: boolean;
	manualTranslation: string | undefined;
	ownMessage: boolean;
	mode: string;
	messageType: string;
	localCard: boolean;
	keepOnDevice: boolean;
}): AutoTranslationSkip {
	if (input.keepOnDevice) return 'kept';
	if (!input.visible) return 'not-visible';
	if (input.manualTranslation) return 'manual';
	if (input.ownMessage) return 'own';
	if (input.mode !== 'auto') return 'mode';
	if (input.messageType !== 'text' && input.messageType !== 'gif') return 'type';
	if (input.localCard) return 'local';
	return null;
}
