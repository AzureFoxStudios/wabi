import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** Static single-page app served by the Sabi server (no Node SSR runtime needed). */
export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ pages: 'build', assets: 'build', fallback: 'index.html', strict: false }),
    alias: { $components: 'src/lib/components' },
  },
};
