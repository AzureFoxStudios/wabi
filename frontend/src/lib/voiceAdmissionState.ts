export interface VoiceAdmissionConstraint {
	channelId: string;
	listeningOnly: boolean;
	mutedOnEntry: boolean;
	serverMuted: boolean;
	serverDeafened: boolean;
	updatedAt: number;
}

const byChannel = new Map<string, VoiceAdmissionConstraint>();

export function rememberVoiceAdmission(channelId: string, reply: {
	listeningOnly?: boolean;
	mutedOnEntry?: boolean;
	serverMuted?: boolean;
	serverDeafened?: boolean;
}): VoiceAdmissionConstraint {
	const value: VoiceAdmissionConstraint = {
		channelId,
		listeningOnly: reply.listeningOnly === true,
		mutedOnEntry: reply.mutedOnEntry === true,
		serverMuted: reply.serverMuted === true,
		serverDeafened: reply.serverDeafened === true,
		updatedAt: Date.now()
	};
	byChannel.set(channelId, value);
	return value;
}

export function getVoiceAdmission(channelId: string | null | undefined): VoiceAdmissionConstraint | null {
	if (!channelId) return null;
	return byChannel.get(channelId) ?? null;
}

export function voiceAdmissionForcesListen(channelId: string | null | undefined): boolean {
	return getVoiceAdmission(channelId)?.listeningOnly === true;
}

export function voiceAdmissionBlocksMicrophone(channelId: string | null | undefined): boolean {
	const admission = getVoiceAdmission(channelId);
	return Boolean(admission?.listeningOnly || admission?.serverMuted);
}

export function clearVoiceAdmission(channelId: string): void {
	byChannel.delete(channelId);
}

export function clearVoiceAdmissions(): void {
	byChannel.clear();
}
