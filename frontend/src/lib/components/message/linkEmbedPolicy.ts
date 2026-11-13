/**
 * What MessageLinkEmbeds draws for each link in a message, decided without a DOM so the
 * experimental-encryption rules can be tested (privacy/contentEgress.ts).
 *
 * - `preview`: the LinkPreview card. It asks this server's `/api/url-preview` and
 *   `/api/image-proxy` with the viewer's token, so the server learns the URL. Never for content
 *   that stays on the device; such a link is drawn as a plain link instead.
 * - `direct`: media loaded straight from the link's host (image, video, audio, 3D model, Spotify
 *   player, YouTube watch queue). For content that stays on the device it waits for an explicit
 *   click (`directNeedsClick`), because loading it tells that host the link was opened.
 */
import { isSpotifyUrl } from '$lib/spotifyControls';
import { extractUrls, getMediaType, isYouTubeUrl } from './messageItemUtils';

export type DirectEmbed = 'youtube-queue' | 'spotify' | 'image' | 'video' | 'audio' | 'model';

export type LinkEmbedPlan = {
	url: string;
	/** Draw the LinkPreview card (server-side fetch). */
	preview: boolean;
	/** Draw the bare link (when there is no preview card and no direct embed is shown yet). */
	plainLink: boolean;
	direct: DirectEmbed | null;
	/** The direct embed waits for the viewer's click. */
	directNeedsClick: boolean;
};

export type LinkEmbedContext = {
	/** contentStaysOnDevice(message, room) */
	keepOnDevice: boolean;
	spotifyControlsEnabled: boolean;
	youtubeQueueChannel: boolean;
};

export function planLinkEmbed(url: string, index: number, context: LinkEmbedContext): LinkEmbedPlan {
	const keep = context.keepOnDevice;
	let direct: DirectEmbed | null = null;
	let wantsPreview = false;
	if (isYouTubeUrl(url)) {
		wantsPreview = true;
		if (context.youtubeQueueChannel && index === 0) direct = 'youtube-queue';
	} else if (context.spotifyControlsEnabled && isSpotifyUrl(url)) {
		direct = 'spotify';
	} else {
		const media = getMediaType(url);
		if (media) direct = media;
		else wantsPreview = true;
	}
	const preview = wantsPreview && !keep;
	return {
		url,
		preview,
		plainLink: !preview && (keep || wantsPreview),
		direct,
		directNeedsClick: Boolean(direct) && keep
	};
}

export function planLinkEmbeds(text: string, context: LinkEmbedContext): LinkEmbedPlan[] {
	if (!text) return [];
	return extractUrls(text).map((url, index) => planLinkEmbed(url, index, context));
}

/** Load the LinkPreview component only when some link in this message will use it. */
export function needsLinkPreviewComponent(text: string, context: LinkEmbedContext): boolean {
	return planLinkEmbeds(text, context).some((plan) => plan.preview);
}
