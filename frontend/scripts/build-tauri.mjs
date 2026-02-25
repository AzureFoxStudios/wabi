import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const env = { ...process.env };

if (!env.TAURI_ENV_PLATFORM) {
	if (process.platform === 'win32') {
		env.TAURI_ENV_PLATFORM = 'windows';
	} else if (process.platform === 'darwin') {
		env.TAURI_ENV_PLATFORM = 'macos';
	} else {
		env.TAURI_ENV_PLATFORM = process.platform;
	}
}

const viteCliPath = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const appRoot = fileURLToPath(new URL('../', import.meta.url));

const child = spawn(process.execPath, [viteCliPath, 'build'], {
	stdio: 'inherit',
	env,
	cwd: appRoot
});

child.on('error', (error) => {
	console.error('[build:tauri] Failed to start build process:', error);
	process.exit(1);
});

child.on('exit', (code, signal) => {
	if (signal) {
		console.error(`[build:tauri] Build terminated by signal ${signal}`);
		process.exit(1);
	}
	process.exit(code ?? 1);
});
