import type { E2eeRoomStatus } from '$lib/e2ee';

export interface AlbumsAgreementView {
	/** Every current member agreed: albums are open. */
	open: boolean;
	agreedByMe: boolean;
	/** Members who agreed, this one included. */
	agreedCount: number;
	/** Members who have not agreed yet. */
	waitingFor: number;
	/** Someone else agreed and this member has not: worth telling them. */
	askedByOthers: boolean;
}

/** What the agreement controls show, from the conversation's last known status. */
export function albumsAgreementView(status: E2eeRoomStatus | null | undefined): AlbumsAgreementView {
	const members = status?.memberUserIds ?? [];
	const agreed = (status?.albumsAgreedUserIds ?? []).filter((id) => members.length === 0 || members.includes(id));
	const agreedByMe = status?.albumsAgreedByMe === true;
	const open = status?.albumsAgreed === true;
	return {
		open,
		agreedByMe,
		agreedCount: agreed.length,
		waitingFor: Math.max(0, members.length - agreed.length),
		askedByOthers: !open && !agreedByMe && agreed.length > 0
	};
}
