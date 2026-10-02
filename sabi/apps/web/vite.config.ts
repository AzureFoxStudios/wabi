import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const api = process.env.SABI_API ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: { '/api': { target: api, changeOrigin: false } },
  },
  build: { target: 'es2022' },
});
