import { browser } from '$app/environment';

export type ReverseImageSearchProvider = 'google_lens' | 'bing' | 'tineye' | 'yandex';

const REVERSE_IMAGE_SEARCH_PROVIDER_KEY = 'wabi.imageUtilities.reverseSearchProvider';
const DEFAULT_PROVIDER: ReverseImageSearchProvider = 'google_lens';

function isProvider(value: string | null): value is ReverseImageSearchProvider {
	return value === 'google_lens' || value === 'bing' || value === 'tineye' || value === 'yandex';
}

export function getReverseImageSearchProvider(): ReverseImageSearchProvider {
	if (!browser) return DEFAULT_PROVIDER;
	try {
		const raw = localStorage.getItem(REVERSE_IMAGE_SEARCH_PROVIDER_KEY);
		return isProvider(raw) ? raw : DEFAULT_PROVIDER;
	} catch {
		return DEFAULT_PROVIDER;
	}
}

export function setReverseImageSearchProvider(provider: ReverseImageSearchProvider): void {
	if (!browser) return;
	try {
		localStorage.setItem(REVERSE_IMAGE_SEARCH_PROVIDER_KEY, provider);
	} catch {
		// best effort
	}
}

function encodedImageUrl(imageUrl: string): string {
	return encodeURIComponent(imageUrl);
}

export function buildReverseImageSearchUrl(
	imageUrl: string,
	provider: ReverseImageSearchProvider
): string {
	const encoded = encodedImageUrl(imageUrl);
	if (provider === 'bing') {
		return `https://www.bing.com/images/search?q=imgurl:${encoded}&view=detailv2&iss=sbi&FORM=IRSBIQ`;
	}
	if (provider === 'tineye') {
		return `https://tineye.com/search?url=${encoded}`;
	}
	if (provider === 'yandex') {
		return `https://yandex.com/images/search?rpt=imageview&url=${encoded}`;
	}
	return `https://lens.google.com/uploadbyurl?url=${encoded}`;
}

