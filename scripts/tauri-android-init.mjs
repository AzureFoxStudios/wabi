#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const root = resolve(import.meta.dirname, '..');

const init = spawnSync('bunx', ['tauri', 'android', 'init', ...args], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32'
});
if (init.status !== 0) process.exit(init.status ?? 1);

const activity = resolve(
  root,
  'src-tauri/gen/android/app/src/main/java/chat/wabi/app/MainActivity.kt'
);
if (!existsSync(activity)) {
  console.error(`[android:init] generated MainActivity not found: ${activity}`);
  process.exit(1);
}

const current = readFileSync(activity, 'utf8');
if (current.includes('initNdkContext(this.applicationContext)')) {
  console.log('[android:init] secure credential-store context already wired');
  process.exit(0);
}

const packageLine = 'package chat.wabi.app';
if (!current.includes(packageLine) || !current.includes('class MainActivity : TauriActivity()')) {
  console.error('[android:init] MainActivity template changed; refusing an unsafe blind patch');
  process.exit(1);
}

const patched = `${packageLine}\n\nimport android.content.Context\nimport android.os.Bundle\n\nclass MainActivity : TauriActivity() {\n  private external fun initNdkContext(context: Context)\n\n  override fun onCreate(savedInstanceState: Bundle?) {\n    super.onCreate(savedInstanceState)\n    initNdkContext(this.applicationContext)\n  }\n}\n`;
writeFileSync(activity, patched, 'utf8');
console.log('[android:init] wired Android Keystore context into generated MainActivity');
