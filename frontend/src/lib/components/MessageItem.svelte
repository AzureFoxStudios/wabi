<script lang="ts">
	import { onMount } from 'svelte';
	import type { Message } from '$lib/socket';
	import {
		getTranslatorSettings,
		TRANSLATOR_SETTINGS_CHANGED_EVENT,
		type TranslatorSettings
	} from './message/messageTranslator';
	import { observeTranslatorVisibility } from '$lib/addons/translatorViewport';
	import MessageItemContent from './MessageItemContent.svelte';
	import { autoTranslationSkip } from '$lib/addons/translatorAutoPolicy';
	import { keepReasonFor } from '$lib/privacy/contentEgress';
	import { e2eeStatusRevision, roomContentKeepReason } from '$lib/dm/dmE2eeState';

	let {
		message,
		messageDomId = '',
		translatedText = undefined,
		translationLoading = false,
		ownMessage = false,
		editText = '',
		...rest
	} = $props<{
		message: Message;
		messageDomId?: string;
		translatedText?: string;
		translationLoading?: boolean;
		ownMessage?: boolean;
		editText?: string;
		[key: string]: unknown;
	}>();

	let translatorSettings = $state<TranslatorSettings>(getTranslatorSettings());
	let isNearViewport = $state(false);
	let autoTranslatedText = $state<string | undefined>(undefined);
	let autoTranslationLoading = $state(false);
	let lastAutoRequestKey = $state('');
	let requestGeneration = 0;

	// Kept content (privacy/contentEgress.ts) is never auto-translated. Derived here from the
	// message and the room, so a parent cannot switch it off.
	let channelId = $derived(String(rest.currentChannel ?? ''));
	let channelType = $derived(
		((rest.channels as Array<{ id: string; type?: string }> | undefined) ?? []).find((channel) => channel.id === channelId)?.type ?? null
	);
	let roomKeep = $derived(roomContentKeepReason(channelId, channelType, $e2eeStatusRevision));
	let contentOnDevice = $derived(keepReasonFor(message, roomKeep) !== null);

	let effectiveTranslatedText = $derived(translatedText ?? autoTranslatedText);
	let effectiveTranslationLoading = $derived(translationLoading || autoTranslationLoading);

	onMount(() => {
		const element = document.getElementById(messageDomId || `message-${message.id}`);
		const stopObserving = element
			? observeTranslatorVisibility(element, (visible) => {
				isNearViewport = visible;
			})
			: () => {};

		const handleSettingsChanged = (event: Event) => {
			const detail = (event as CustomEvent<TranslatorSettings>).detail;
			translatorSettings = detail || getTranslatorSettings();
			if (translatorSettings.mode !== 'auto') {
				requestGeneration += 1;
				autoTranslatedText = undefined;
				autoTranslationLoading = false;
				lastAutoRequestKey = '';
			}
		};
		window.addEventListener(TRANSLATOR_SETTINGS_CHANGED_EVENT, handleSettingsChanged);

		return () => {
			stopObserving();
			window.removeEventListener(TRANSLATOR_SETTINGS_CHANGED_EVENT, handleSettingsChanged);
			requestGeneration += 1;
		};
	});

	$effect(() => {
		const text = message.text || '';
		const settings = translatorSettings;
		const skip = autoTranslationSkip({
			visible: isNearViewport,
			manualTranslation: translatedText,
			ownMessage,
			mode: settings.mode,
			messageType: String(message.type || ''),
			localCard: Boolean(message.localCard || message.userId === 'local-directions'),
			keepOnDevice: contentOnDevice
		});
		if (skip === 'kept') {
			// Kept content: drop any translation in flight and forget the last request, so it is
			// asked again if the room later turns out to be server-readable.
			requestGeneration += 1;
			autoTranslatedText = undefined;
			autoTranslationLoading = false;
			lastAutoRequestKey = '';
			return;
		}
		if (skip) return;
		void runAutoTranslation(text, settings);
	});

	async function runAutoTranslation(text: string, settings: TranslatorSettings): Promise<void> {
		const requestKey = [
			message.id,
			text,
			settings.providerUrl,
			settings.targetLang,
			settings.understoodLanguages.join(',')
		].join('\n');
		if (requestKey === lastAutoRequestKey) return;
		lastAutoRequestKey = requestKey;
		autoTranslatedText = undefined;

		const generation = ++requestGeneration;
		autoTranslationLoading = true;
		try {
			const { requestAutoTranslation } = await import('$lib/addons/translatorAuto');
			const result = await requestAutoTranslation(message.id, text, settings, { message, channelId, channelType });
			if (generation !== requestGeneration) return;
			autoTranslatedText = result?.translatedText || undefined;
		} catch {
			// Auto translation is assistive UI. Provider failures stay quiet here;
			// Settings > Add-ons exposes an explicit health check for diagnosis.
			if (generation === requestGeneration) autoTranslatedText = undefined;
		} finally {
			if (generation === requestGeneration) autoTranslationLoading = false;
		}
	}
</script>

<MessageItemContent
	{...rest}
	{message}
	{messageDomId}
	{ownMessage}
	translatedText={effectiveTranslatedText}
	translationLoading={effectiveTranslationLoading}
	{editText}
/>
