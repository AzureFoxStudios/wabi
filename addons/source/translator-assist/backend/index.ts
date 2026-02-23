import type { BackendPlugin } from '../../../backend/src/plugins/types';

function sanitizeString(input: unknown, maxLen: number): string {
	if (typeof input !== 'string') return '';
	return input.trim().slice(0, maxLen);
}

const plugin: BackendPlugin = {
	name: 'translator-assist',

	routes: [
		{
			method: 'get',
			path: '/capabilities',
			handler: async (_req, res) => {
				res.json({
					success: true,
					plugin: 'translator-assist',
					modes: ['frontend-direct', 'proxy-optional'],
					defaultMode: 'frontend-direct',
					notes: 'Per-user endpoint settings are intended to be stored client-side.'
				});
			}
		},
		{
			method: 'post',
			path: '/translate',
			handler: async (req, res) => {
				const body = await req.json();
				const providerUrl = sanitizeString(body?.providerUrl, 500);
				const text = sanitizeString(body?.text, 8000);
				const sourceLang = sanitizeString(body?.sourceLang, 16) || 'auto';
				const targetLang = sanitizeString(body?.targetLang, 16) || 'en';
				const apiKey = sanitizeString(body?.apiKey, 512);

				if (!providerUrl || !text || !targetLang) {
					res.status(400).json({ success: false, error: 'providerUrl, text, and targetLang are required' });
					return;
				}

				try {
					const headers: Record<string, string> = {
						'Content-Type': 'application/json'
					};
					if (apiKey) {
						headers.Authorization = `Bearer ${apiKey}`;
					}

					const upstream = await fetch(providerUrl, {
						method: 'POST',
						headers,
						body: JSON.stringify({
							q: text,
							source: sourceLang,
							target: targetLang,
							format: 'text'
						})
					});

					const raw = await upstream.text();
					if (!upstream.ok) {
						res.status(502).json({
							success: false,
							error: `Translator upstream failed (${upstream.status})`,
							details: raw.slice(0, 600)
						});
						return;
					}

					let translatedText = '';
					try {
						const parsed = JSON.parse(raw);
						translatedText = sanitizeString(
							parsed?.translatedText || parsed?.translation || parsed?.data?.translatedText || '',
							8000
						);
					} catch {
						translatedText = sanitizeString(raw, 8000);
					}

					res.json({
						success: true,
						translatedText,
						targetLang,
						sourceLang
					});
				} catch (error) {
					res.status(500).json({
						success: false,
						error: error instanceof Error ? error.message : 'Translator proxy request failed'
					});
				}
			}
		}
	]
};

export default plugin;
