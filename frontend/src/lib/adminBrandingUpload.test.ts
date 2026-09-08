import { expect, test } from 'bun:test';
import { uploadAdminBrandingAsset } from './adminBrandingUpload';

const base = () => ({ server: 'https://branding.test', token: 'local-fixture', file: new File(['art'], 'icon.png', { type: 'image/png' }), signal: new AbortController().signal });

test('branding upload sends the exact file/credentials to its captured server and returns only the draft URL', async () => {
	const options = base();
	let calls = 0;
	const url = await uploadAdminBrandingAsset({ ...options, request: async (url, init) => {
		calls++;
		expect(url).toBe('https://branding.test/api/upload');
		expect(new Headers(init.headers).get('Authorization')).toBe('Bearer local-fixture');
		expect(new Headers(init.headers).has('Content-Type')).toBe(false);
		const sent = (init.body as FormData).get('file') as File;
		expect(sent.name).toBe(options.file.name);
		expect(sent.type).toBe(options.file.type);
		expect(await sent.text()).toBe(await options.file.text());
		return Response.json({ fileUrl: '/uploads/draft.png' });
	} });
	expect(calls).toBe(1);
	expect(url).toBe('/uploads/draft.png');
});

test('bad type or oversize artwork does not make a request', async () => {
	let calls = 0;
	const request = async () => { calls++; return Response.json({ fileUrl: '/unreachable' }); };
	await expect(uploadAdminBrandingAsset({ ...base(), file: new File(['<svg/>'], 'icon.svg', { type: 'image/svg+xml' }), request })).rejects.toThrow('Use PNG');
	await expect(uploadAdminBrandingAsset({ ...base(), file: new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'icon.png', { type: 'image/png' }), request })).rejects.toThrow('10 MB');
	expect(calls).toBe(0);
});

test('error, SPA fallback and malformed success never become draft artwork', async () => {
	for (const response of [Response.json({ error: 'Storage unavailable' }, { status: 503 }), new Response('<html>fallback</html>'), Response.json({}), Response.json({ fileUrl: {} }), Response.json({ fileUrl: ' ' })]) {
		await expect(uploadAdminBrandingAsset({ ...base(), request: async () => response })).rejects.toThrow();
	}
});

test('deadline includes an unresponsive response body and releases an editor even if a transport ignores abort', async () => {
	let signal: AbortSignal | null = null;
	await expect(uploadAdminBrandingAsset({ ...base(), timeoutMs: 5, request: async (_, init) => {
		signal = init.signal!;
		return { ok: true, json: () => new Promise(() => {}) } as Response;
	} })).rejects.toThrow('could not be confirmed in time');
	expect(signal!.aborted).toBe(true);
});

test('closing an editor cancels pending work; a retired upload cannot publish a late URL', async () => {
	const controller = new AbortController();
	let finish!: (response: Response) => void;
	let requestSignal: AbortSignal | null = null;
	const pending = uploadAdminBrandingAsset({ ...base(), signal: controller.signal, request: (_, init) => {
		requestSignal = init.signal!;
		return new Promise(resolve => { finish = resolve; });
	} });
	controller.abort(new Error('Editor closed'));
	await expect(pending).rejects.toThrow('Editor closed');
	expect(requestSignal!.aborted).toBe(true);
	finish(Response.json({ fileUrl: '/late.png' }));
	let requests = 0;
	await expect(uploadAdminBrandingAsset({ ...base(), signal: controller.signal, request: async () => { requests++; return Response.json({}); } })).rejects.toThrow('Editor closed');
	expect(requests).toBe(0);
});
