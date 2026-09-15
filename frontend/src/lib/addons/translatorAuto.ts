import {
	requestLanguageDetection,
	requestTranslationDetailed,
	shouldAutoTranslateDetectedLanguage,
	type TranslationResult,
	type TranslatorSettings
} from '$lib/components/message/messageTranslator';

const MAX_CONCURRENT_AUTO_TRANSLATIONS = 2;
const MAX_AUTO_CACHE_ENTRIES = 500;
const FAILURE_COOLDOWN_MS = 15_000;

let activeCount = 0;
let providerFailureUntil = 0;
const queue: Array<() => void> = [];
const pending = new Map<string, Promise<TranslationResult | null>>();
const resultCache = new Map<string, TranslationResult | null>();

export function isAutoTranslationCandidateText(text: string): boolean {
	const input = text.trim();
	if (input.length < 2 || input.length > 8_000) return false;
	if (/^\/[\p{L}\p{N}_-]+(?:\s|$)/u.test(input)) return false;
	if (/^```[\s\S]*```$/.test(input)) return false;
	if (/^(?:https?:\/\/|www\.)\S+$/i.test(input)) return false;

	const meaningful = input
		.replace(/https?:\/\/\S+/gi, ' ')
		.replace(/<@!?[^>]+>/g, ' ')
		.replace(/@[\p{L}\p{N}_.-]+/gu, ' ')
		.replace(/:[a-z0-9_+-]+:/gi, ' ')
		.trim();
	return /[\p{L}\p{N}]/u.test(meaningful);
}

export function requestAutoTranslation(
	messageKey: string,
	text: string,
	settings: TranslatorSettings
): Promise<TranslationResult | null> {
	if (settings.mode !== 'auto' || !isAutoTranslationCandidateText(text)) {
		return Promise.resolve(null);
	}
	if (Date.now() < providerFailureUntil) return Promise.resolve(null);

	const key = buildCacheKey(messageKey, text, settings);
	if (resultCache.has(key)) return Promise.resolve(resultCache.get(key) ?? null);
	const existing = pending.get(key);
	if (existing) return existing;

	const work = enqueue(async () => {
		try {
			const detectedLanguage = await requestLanguageDetection(text, settings);
			if (!detectedLanguage || !shouldAutoTranslateDetectedLanguage(detectedLanguage, settings)) {
				rememberResult(key, null);
				return null;
			}

			const translated = await requestTranslationDetailed(text, settings);
			const result: TranslationResult = {
				...translated,
				detectedLanguage: translated.detectedLanguage || detectedLanguage
			};
			rememberResult(key, result);
			return result;
		} catch {
			// A dead translator must not make every visible message fire another
			// failing request. Back off briefly; the explicit settings health check
			// remains available for diagnosis.
			providerFailureUntil = Date.now() + FAILURE_COOLDOWN_MS;
			return null;
		}
	});

	pending.set(key, work);
	void work.finally(() => {
		pending.delete(key);
	});
	return work;
}

export function clearAutoTranslationState(): void {
	resultCache.clear();
	pending.clear();
	providerFailureUntil = 0;
}

function buildCacheKey(messageKey: string, text: string, settings: TranslatorSettings): string {
	return [
		settings.providerUrl,
		settings.targetLang,
		settings.understoodLanguages.join(','),
		messageKey,
		text
	].join('\n');
}

function rememberResult(key: string, result: TranslationResult | null): void {
	if (resultCache.has(key)) resultCache.delete(key);
	resultCache.set(key, result);
	while (resultCache.size > MAX_AUTO_CACHE_ENTRIES) {
		const oldest = resultCache.keys().next().value;
		if (typeof oldest !== 'string') break;
		resultCache.delete(oldest);
	}
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const run = () => {
			activeCount += 1;
			void task()
				.then(resolve, reject)
				.finally(() => {
					activeCount -= 1;
					pumpQueue();
				});
		};
		queue.push(run);
		pumpQueue();
	});
}

function pumpQueue(): void {
	while (activeCount < MAX_CONCURRENT_AUTO_TRANSLATIONS && queue.length > 0) {
		const next = queue.shift();
		if (next) next();
	}
}
