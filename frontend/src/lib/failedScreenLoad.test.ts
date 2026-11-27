import { describe, expect, test } from 'bun:test';
import { isFailedModuleLoad } from './failedScreenLoad';

describe('a screen that fails to load', () => {
	test('is recognised from each browser\'s wording', () => {
		for (const message of [
			'Failed to fetch dynamically imported module: https://example.test/_app/immutable/chunks/a.js',
			'error loading dynamically imported module: https://example.test/_app/immutable/chunks/a.js',
			'Importing a module script failed.',
			"Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of \"text/html\". 'text/html' is not a valid JavaScript MIME type.",
			'Unable to preload CSS for /_app/immutable/assets/a.css'
		]) {
			expect(isFailedModuleLoad(new TypeError(message))).toBe(true);
		}
	});

	test('other errors are left alone', () => {
		expect(isFailedModuleLoad(new Error('Request failed (500)'))).toBe(false);
		expect(isFailedModuleLoad(undefined)).toBe(false);
		expect(isFailedModuleLoad({ message: 'dynamically imported module' })).toBe(false);
	});
});
