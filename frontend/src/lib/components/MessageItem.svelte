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
		const visible = isNearViewport;
		const manualTranslation = translatedText;
		const isOwn = ownMessage;
		const messageType = String(message.type || '');
		if (!visible || manualTranslation || isOwn || settings.mode !== 'auto') return;
		if (messageType !== 'text' && messageType !== 'gif') return;
		if (message.localCard || message.userId === 'local-directions') return;
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
			const result = await requestAutoTranslation(message.id, text, settings);
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
