import fs from 'fs';
import path from 'path';
import {
	calculatePluginChecksum,
	parseArgs,
	readManifest,
	resolvePluginDir,
	verifyChecksumSignature
} from './plugin-crypto.mjs';

function upsertEnvLine(content, key, value) {
	const lines = content.split(/\r?\n/);
	const nextLine = `${key}=${value}`;
	const index = lines.findIndex((line) => line.trim().startsWith(`${key}=`));
	if (index >= 0) {
		lines[index] = nextLine;
	} else {
		lines.push(nextLine);
	}
	return `${lines.join('\n').replace(/\n{2,}$/g, '\n')}\n`;
}

async function registerSigner(server, token, keyId, publicKey, note) {
	const response = await fetch(`${server.replace(/\/+$/, '')}/api/plugins/signers`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json'
		},
		body: JSON.stringify({
			keyId,
			publicKey,
			note: note || 'payments-signed-only-rollout'
		})
	});
	const payload = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(payload.error || `Failed to trust signer (HTTP ${response.status})`);
	}
	return payload;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const pluginDir = resolvePluginDir(args.plugin || 'plugins/th-payments');
	const envPath = typeof args['env-file'] === 'string' ? path.resolve(process.cwd(), args['env-file']) : null;
	const server = typeof args.server === 'string' ? args.server.trim() : '';
	const adminToken = typeof args.token === 'string' ? args.token.trim() : '';
	const note = typeof args.note === 'string' ? args.note.trim() : '';
	const writeEnv = Boolean(args['write-env']);

	const { manifestPath, manifest } = readManifest(pluginDir);
	const checksum = calculatePluginChecksum(pluginDir);
	const declaredChecksum = manifest.integrity?.checksum;
	const signature = manifest.integrity?.signature;
	const publicKey = manifest.signer?.publicKey;
	const keyId = manifest.signer?.keyId;

	if (!declaredChecksum) {
		throw new Error('plugin manifest is missing integrity.checksum');
	}
	if (declaredChecksum !== checksum) {
		throw new Error(`checksum mismatch: declared=${declaredChecksum} actual=${checksum}`);
	}
	if (!signature || signature === 'unsigned-local-dev') {
		throw new Error('plugin manifest is missing integrity.signature');
	}
	if (!publicKey || !keyId) {
		throw new Error('plugin manifest is missing signer.publicKey or signer.keyId');
	}
	if (!verifyChecksumSignature(checksum, signature, publicKey)) {
		throw new Error('signature verification failed');
	}

	let signerRegistration = null;
	if (server || adminToken) {
		if (!server || !adminToken) {
			throw new Error('both --server and --token are required when registering signer');
		}
		signerRegistration = await registerSigner(server, adminToken, keyId, publicKey, note);
	}

	if (writeEnv) {
		if (!envPath) {
			throw new Error('--write-env requires --env-file <path>');
		}
		const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
		let next = upsertEnvLine(existing, 'PLUGIN_SIGNATURE_POLICY', 'signed-only');
		next = upsertEnvLine(next, 'PLUGINS_ENABLED', 'true');
		fs.writeFileSync(envPath, next);
	}

	console.log(
		JSON.stringify(
			{
				ok: true,
				pluginDir,
				manifestPath,
				keyId,
				checksum,
				signatureVerified: true,
				signerRegistered: Boolean(signerRegistration),
				envWritten: Boolean(writeEnv),
				envPath: envPath || null
			},
			null,
			2
		)
	);
}

main().catch((error) => {
	console.error('[payments-signed-only-rollout] FAIL', error instanceof Error ? error.message : error);
	process.exit(1);
});
