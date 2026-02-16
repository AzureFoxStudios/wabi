const isTauri = !!process.env.TAURI_ENV_PLATFORM;

const adapter = isTauri
	? (await import('@sveltejs/adapter-static')).default({
			fallback: 'index.html'
		})
	: (await import('@sveltejs/adapter-node')).default();

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: [],
	kit: {
		adapter,
		...(isTauri
			? { prerender: { entries: [] } }
			: {
					serviceWorker: { register: true }
				})
	}
};

export default config;
