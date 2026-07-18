import type { ObjectRefRecord, ObjectRefKind } from './objectRefRegistry';
import { slugify } from './objectRefRegistry';

const KIND_NS: Record<ObjectRefKind, string> = {
	forum_post: 'f',
	wiki_page: 'w',
	gallery_work: 'g',
	place: 'm',
};

interface ShareEntity {
	kind: ObjectRefKind;
	start: number;
	end: number;
	targetId: string;
	label: string;
	displayText?: string | null;
}

export function buildSharePayload(record: ObjectRefRecord): { text: string; entities: ShareEntity[] } {
	const slug = record.slug || slugify(record.title);
	const token = `^${KIND_NS[record.kind]}/${slug} `;
	const text = `check this ${token}`;
	const start = text.indexOf(token);
	return {
		text,
		entities: [
			{
				kind: record.kind,
				start,
				end: start + token.length - 1,
				targetId: record.id,
				label: slug,
				displayText: token.trim(),
			},
		],
	};
}

export function buildShareLink(record: ObjectRefRecord, baseUrl = 'https://wabi.chat'): string {
	const ref = `${record.kind}:${record.id}`;
	return `${baseUrl}/c/${record.channelId || ''}?ref=${encodeURIComponent(ref)}`;
}

export function buildShareRefText(record: ObjectRefRecord): string {
	const slug = record.slug || slugify(record.title);
	return `^${KIND_NS[record.kind]}/${slug}`;
}

export async function copyToClipboard(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		/* ignore */
	}
}
