import { spawnSync } from 'node:child_process';

const forceStatic = process.argv.includes('--static');
const env = { ...process.env };

if (forceStatic) {
	env.STATIC_BUILD = '1';
}

if (!env.STATIC_BUILD) {
	console.log('');
	console.log('⚠️  STATIC_BUILD is unset. Default frontend build uses adapter-node (no index.html).');
	console.log('    For production / Docker / deploy, use: npm run build:static');
	console.log('    The static build (adapter-static) emits index.html for rust_embed.');
	console.log('');
	console.log('    Building with adapter-node anyway (for dev/SSR use). Set STATIC_BUILD=1 to silence.');
	console.log('');
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['run', 'build:only'], {
	cwd: new URL('../', import.meta.url),
	env,
	stdio: 'inherit'
});

if (result.error) {
	console.error('[build] Failed to start Vite build:', result.error);
	process.exit(1);
}

process.exit(result.status ?? 1);
