import { spawn } from 'child_process';
import Database from 'better-sqlite3';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';
import { fileURLToPath } from 'url';

type JsonRecord = Record<string, any>;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

async function getFreePort(): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address !== 'object') {
				server.close();
				reject(new Error('failed_to_allocate_port'));
				return;
			}
			const { port } = address;
			server.close((closeError) => {
				if (closeError) {
					reject(closeError);
					return;
				}
				resolve(port);
			});
		});
	});
}

async function fetchJson(
	url: string,
	init?: RequestInit
): Promise<{ status: number; ok: boolean; data: JsonRecord; text: string }> {
	const response = await fetch(url, init);
	const text = await response.text();
	let data: JsonRecord = {};
	try {
		data = text ? (JSON.parse(text) as JsonRecord) : {};
	} catch {
		data = {};
	}
	return {
		status: response.status,
		ok: response.ok,
		data,
		text
	};
}

async function waitForHealth(baseUrl: string, hasExited: () => boolean): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < 20_000) {
		if (hasExited()) {
			throw new Error('backend_exited_before_healthcheck');
		}
		try {
			const response = await fetch(`${baseUrl}/health`);
			if (response.ok) {
				return;
			}
		} catch {
			// retry
		}
		await delay(250);
	}
	throw new Error('backend_healthcheck_timeout');
}

function insertDmChannel(
	databasePath: string,
	params: {
		channelId: string;
		creatorUserId: number;
		creatorUsername: string;
		counterpartyUserId: number;
		counterpartyUsername: string;
	}
): void {
	const sqlite = new Database(databasePath);
	try {
		const now = Date.now();
		sqlite
			.prepare(
				`
					INSERT INTO channels (
						channel_id,
						channel_type,
						name,
						description,
						min_role,
						created_at,
						created_by,
						persist_messages,
						watch_queue_enabled,
						is_archived
					)
					VALUES (?, 'dm', ?, '', 'member', ?, ?, 1, 0, 0)
				`
			)
			.run(
				params.channelId,
				`${params.creatorUsername}, ${params.counterpartyUsername}`,
				now,
				`user-${params.creatorUserId}`
			);
		sqlite
			.prepare(
				`
					INSERT INTO channel_members (
						channel_id,
						user_id,
						username,
						registered_user_id,
						joined_at,
						role
					)
					VALUES (?, ?, ?, ?, ?, 'member')
				`
			)
			.run(params.channelId, `user-${params.creatorUserId}`, params.creatorUsername, params.creatorUserId, now);
		sqlite
			.prepare(
				`
					INSERT INTO channel_members (
						channel_id,
						user_id,
						username,
						registered_user_id,
						joined_at,
						role
					)
					VALUES (?, ?, ?, ?, ?, 'member')
				`
			)
			.run(
				params.channelId,
				`user-${params.counterpartyUserId}`,
				params.counterpartyUsername,
				params.counterpartyUserId,
				now
			);
	} finally {
		sqlite.close();
	}
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, '..');
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wabi-payments-local-e2e-'));

fs.mkdirSync(path.join(smokeRoot, 'data'), { recursive: true });
fs.mkdirSync(path.join(smokeRoot, 'uploads'), { recursive: true });

const port = await getFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const env = {
	...process.env,
	NODE_ENV: 'development',
	BACKEND_PORT: String(port),
	PORT: String(port),
	DB_MODE: 'sqlite',
	DATABASE_PATH: path.join(smokeRoot, 'data', 'chat.db'),
	DATA_DIR: path.join(smokeRoot, 'data'),
	UPLOADS_DIR: path.join(smokeRoot, 'uploads'),
	FRONTEND_URL: 'http://localhost:5173',
	PUBLIC_URL: baseUrl,
	ALLOWED_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173,http://localhost,http://127.0.0.1',
	JWT_SECRET: 'payments-local-e2e-smoke-secret-123456789',
	PLUGINS_ENABLED: 'true',
	PLUGINS_ALLOW_INSTALL: 'false',
	PLUGINS_DIR: '../plugins',
	PLUGIN_SIGNATURE_POLICY: 'signed-only',
	WABI_PUBLIC_BASE_URL: baseUrl,
	TH_PAYMENTS_PROMPTPAY_PROXY_ID: '0812345678',
	WEST_PAYMENTS_TEST_MODE: 'true',
	PAYMENTS_ACCESS_BOOTSTRAP_MODE: 'seed_if_missing',
	PAYMENTS_ACCESS_ENABLED: 'true',
	PAYMENTS_ACCESS_ALLOW_GUEST: 'false',
	PAYMENTS_ACCESS_ALLOWED_ROLES: 'owner,admin,mod,member'
};

const server = spawn(process.execPath, ['dist/server.js'], {
	cwd: backendDir,
	env,
	stdio: ['ignore', 'pipe', 'pipe']
});

let serverExited = false;
let serverLog = '';

server.stdout.on('data', (chunk) => {
	serverLog += chunk.toString();
});
server.stderr.on('data', (chunk) => {
	serverLog += chunk.toString();
});
server.on('exit', () => {
	serverExited = true;
});

try {
	await waitForHealth(baseUrl, () => serverExited);

	const guestAccess = await fetchJson(`${baseUrl}/api/payments/access`);
	assert(guestAccess.ok, `guest access request failed: ${guestAccess.status} ${guestAccess.text}`);
	assert(guestAccess.data.policy?.enabled === true, 'payment policy was not enabled by bootstrap');
	assert(guestAccess.data.actor?.authenticated === false, 'guest actor unexpectedly authenticated');
	assert(guestAccess.data.actor?.canCreate === false, 'guest should not be allowed to create payments');

	const thaiProviders = await fetchJson(`${baseUrl}/api/payments/providers?country=TH&currency=THB`);
	assert(thaiProviders.ok, `thai providers request failed: ${thaiProviders.status} ${thaiProviders.text}`);
	assert(
		Array.isArray(thaiProviders.data.providers) &&
			thaiProviders.data.providers.some((provider: JsonRecord) => provider.pluginId === 'th-payments'),
		'th-payments provider missing from TH/THB provider list'
	);

	const westernProviders = await fetchJson(`${baseUrl}/api/payments/providers?country=US&currency=USD`);
	assert(
		westernProviders.ok,
		`western providers request failed: ${westernProviders.status} ${westernProviders.text}`
	);
	assert(
		Array.isArray(westernProviders.data.providers) &&
			westernProviders.data.providers.some((provider: JsonRecord) => provider.pluginId === 'western-payments'),
		'western-payments provider missing from US/USD provider list'
	);

	const registerResponse = await fetchJson(`${baseUrl}/api/auth/register`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			username: 'Payments Smoke',
			handle: 'paymentssmoke',
			password: 'payments-smoke-pass-123'
		})
	});
	assert(
		registerResponse.ok && typeof registerResponse.data.token === 'string' && registerResponse.data.token,
		`register failed: ${registerResponse.status} ${registerResponse.text}`
	);
	const token = registerResponse.data.token as string;
	const primaryUserId = Number(registerResponse.data.user?.id || 0);
	assert(Number.isFinite(primaryUserId) && primaryUserId > 0, 'primary user id missing from register response');
	const authHeaders = {
		Authorization: `Bearer ${token}`,
		'Content-Type': 'application/json'
	};

	const memberAccess = await fetchJson(`${baseUrl}/api/payments/access`, {
		headers: { Authorization: `Bearer ${token}` }
	});
	assert(memberAccess.ok, `member access request failed: ${memberAccess.status} ${memberAccess.text}`);
	assert(memberAccess.data.actor?.authenticated === true, 'registered member should be authenticated');
	assert(memberAccess.data.actor?.canCreate === true, 'registered member should be allowed to create payments');

	const thaiIntent = await fetchJson(`${baseUrl}/api/payments/create`, {
		method: 'POST',
		headers: authHeaders,
		body: JSON.stringify({
			pluginId: 'th-payments',
			methodId: 'promptpay_qr',
			amountMinor: 12500,
			currency: 'THB',
			countryCode: 'TH',
			description: 'Local smoke Thai payment'
		})
	});
	assert(thaiIntent.ok, `thai intent create failed: ${thaiIntent.status} ${thaiIntent.text}`);
	assert(thaiIntent.data.intent?.pluginId === 'th-payments', 'thai intent plugin mismatch');
	assert(thaiIntent.data.intent?.presentation?.mode === 'qr', 'thai intent should use QR presentation');
	assert(
		typeof thaiIntent.data.intent?.presentation?.qrData === 'string' &&
			thaiIntent.data.intent.presentation.qrData.length > 0,
		'thai intent missing qrData'
	);

	const westernIntent = await fetchJson(`${baseUrl}/api/payments/create`, {
		method: 'POST',
		headers: authHeaders,
		body: JSON.stringify({
			pluginId: 'western-payments',
			methodId: 'card_checkout',
			amountMinor: 4999,
			currency: 'USD',
			countryCode: 'US',
			description: 'Local smoke western payment'
		})
	});
	assert(westernIntent.ok, `western intent create failed: ${westernIntent.status} ${westernIntent.text}`);
	assert(westernIntent.data.intent?.pluginId === 'western-payments', 'western intent plugin mismatch');
	const westernCheckoutUrl = String(westernIntent.data.intent?.presentation?.url || '').trim();
	assert(
		westernCheckoutUrl.includes('/api/plugins/runtime/western-payments/test-checkout?providerIntentId='),
		'western intent missing local test checkout url'
	);

	const checkoutPage = await fetch(westernCheckoutUrl);
	assert(checkoutPage.ok, `western test checkout page failed: ${checkoutPage.status}`);

	const providerIntentId = new URL(westernCheckoutUrl).searchParams.get('providerIntentId');
	assert(providerIntentId, 'western test checkout url missing providerIntentId');

	const simulateSuccess = await fetchJson(`${baseUrl}/api/plugins/runtime/western-payments/test-checkout`, {
		method: 'POST',
		headers: authHeaders,
		body: JSON.stringify({
			providerIntentId,
			action: 'succeeded'
		})
	});
	assert(
		simulateSuccess.ok && simulateSuccess.data.status === 'succeeded',
		`western test status update failed: ${simulateSuccess.status} ${simulateSuccess.text}`
	);

	const westernStatus = await fetchJson(
		`${baseUrl}/api/payments/${encodeURIComponent(String(westernIntent.data.intent.intentId))}?refresh=true`,
		{
			headers: { Authorization: `Bearer ${token}` }
		}
	);
	assert(westernStatus.ok, `western status fetch failed: ${westernStatus.status} ${westernStatus.text}`);
	assert(westernStatus.data.intent?.status === 'succeeded', 'western intent did not transition to succeeded');

	const donationIntent = await fetchJson(`${baseUrl}/api/payments/create`, {
		method: 'POST',
		headers: authHeaders,
		body: JSON.stringify({
			pluginId: 'western-payments',
			methodId: 'card_checkout',
			amountMinor: 1500,
			currency: 'USD',
			countryCode: 'US',
			description: 'Server donation smoke',
			metadata: {
				kind: 'server_donation',
				target: 'default_workspace'
			}
		})
	});
	assert(donationIntent.ok, `donation intent create failed: ${donationIntent.status} ${donationIntent.text}`);
	const donationCheckoutUrl = String(donationIntent.data.intent?.presentation?.url || '').trim();
	const donationProviderIntentId = new URL(donationCheckoutUrl).searchParams.get('providerIntentId');
	assert(donationProviderIntentId, 'donation checkout url missing providerIntentId');

	const donationSuccess = await fetchJson(`${baseUrl}/api/plugins/runtime/western-payments/test-checkout`, {
		method: 'POST',
		headers: authHeaders,
		body: JSON.stringify({
			providerIntentId: donationProviderIntentId,
			action: 'succeeded'
		})
	});
	assert(
		donationSuccess.ok && donationSuccess.data.status === 'succeeded',
		`donation checkout success failed: ${donationSuccess.status} ${donationSuccess.text}`
	);

	const donationStatus = await fetchJson(
		`${baseUrl}/api/payments/${encodeURIComponent(String(donationIntent.data.intent.intentId))}?refresh=true`,
		{
			headers: { Authorization: `Bearer ${token}` }
		}
	);
	assert(donationStatus.ok, `donation status fetch failed: ${donationStatus.status} ${donationStatus.text}`);
	assert(donationStatus.data.intent?.status === 'succeeded', 'donation intent did not transition to succeeded');

	const donationSummaryBeforeRefund = await fetchJson(`${baseUrl}/api/payments/donations`);
	assert(
		donationSummaryBeforeRefund.ok,
		`donation summary request failed: ${donationSummaryBeforeRefund.status} ${donationSummaryBeforeRefund.text}`
	);
	assert(
		Array.isArray(donationSummaryBeforeRefund.data.recentDonations) &&
			donationSummaryBeforeRefund.data.recentDonations.some(
				(entry: JsonRecord) =>
					entry.intentId === donationIntent.data.intent.intentId && entry.status === 'succeeded'
			),
		'donation summary missing succeeded donation ledger entry'
	);

	const adminDonationAudit = await fetchJson(`${baseUrl}/api/admin/payments/donations/log`, {
		headers: { Authorization: `Bearer ${token}` }
	});
	assert(
		adminDonationAudit.ok,
		`admin donation audit failed: ${adminDonationAudit.status} ${adminDonationAudit.text}`
	);
	assert(
		Array.isArray(adminDonationAudit.data.donations) &&
			adminDonationAudit.data.donations.some(
				(entry: JsonRecord) =>
					entry.intentId === donationIntent.data.intent.intentId && entry.canRefund === true
			),
		'admin donation audit missing refundable donation entry'
	);

	const donationRefund = await fetchJson(
		`${baseUrl}/api/admin/payments/donations/${encodeURIComponent(String(donationIntent.data.intent.intentId))}/refund`,
		{
			method: 'POST',
			headers: authHeaders,
			body: JSON.stringify({ reason: 'Smoke refund' })
		}
	);
	assert(donationRefund.ok, `donation refund failed: ${donationRefund.status} ${donationRefund.text}`);
	assert(donationRefund.data.intent?.status === 'refunded', 'donation refund did not reach refunded status');

	const donationSummaryAfterRefund = await fetchJson(`${baseUrl}/api/payments/donations`);
	assert(
		donationSummaryAfterRefund.ok,
		`donation summary after refund failed: ${donationSummaryAfterRefund.status} ${donationSummaryAfterRefund.text}`
	);
	assert(
		Array.isArray(donationSummaryAfterRefund.data.recentDonations) &&
			donationSummaryAfterRefund.data.recentDonations.some(
				(entry: JsonRecord) =>
					entry.intentId === donationIntent.data.intent.intentId && entry.status === 'refunded'
			),
		'donation summary missing refunded donation ledger entry'
	);
	assert(
		Array.isArray(donationSummaryAfterRefund.data.totals) &&
			!donationSummaryAfterRefund.data.totals.some((entry: JsonRecord) => Number(entry.amountMinor || 0) >= 1500),
		'refunded donation should not remain in donation totals'
	);

	const registerPrivateUser = await fetchJson(`${baseUrl}/api/auth/register`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			username: 'Private Payments',
			handle: 'privatepayments',
			password: 'private-payments-pass-123'
		})
	});
	assert(
		registerPrivateUser.ok && typeof registerPrivateUser.data.token === 'string' && registerPrivateUser.data.token,
		`private user register failed: ${registerPrivateUser.status} ${registerPrivateUser.text}`
	);
	const privateToken = registerPrivateUser.data.token as string;
	const privateUserId = Number(registerPrivateUser.data.user?.id || 0);
	assert(Number.isFinite(privateUserId) && privateUserId > 0, 'private user id missing from register response');
	const privateAuthHeaders = {
		Authorization: `Bearer ${privateToken}`,
		'Content-Type': 'application/json'
	};

	const dmChannelId = `dm-user-${Math.min(primaryUserId, privateUserId)}-user-${Math.max(primaryUserId, privateUserId)}`;
	insertDmChannel(env.DATABASE_PATH, {
		channelId: dmChannelId,
		creatorUserId: primaryUserId,
		creatorUsername: String(registerResponse.data.user?.username || 'Payments Smoke'),
		counterpartyUserId: privateUserId,
		counterpartyUsername: String(registerPrivateUser.data.user?.username || 'Private Payments')
	});

	const manualCashCreate = await fetchJson(`${baseUrl}/api/manual-cash`, {
		method: 'POST',
		headers: authHeaders,
		body: JSON.stringify({
			channelId: dmChannelId,
			amountMinor: 8800,
			currency: 'THB',
			description: 'Local cash handoff'
		})
	});
	assert(manualCashCreate.ok, `manual cash create failed: ${manualCashCreate.status} ${manualCashCreate.text}`);
	const manualSettlementId = String(manualCashCreate.data.settlement?.settlementId || '');
	assert(manualSettlementId, 'manual cash create response missing settlementId');

	const manualCashListInitial = await fetchJson(`${baseUrl}/api/manual-cash/${encodeURIComponent(dmChannelId)}`, {
		headers: { Authorization: `Bearer ${token}` }
	});
	assert(
		manualCashListInitial.ok &&
			Array.isArray(manualCashListInitial.data.items) &&
			manualCashListInitial.data.items.some((entry: JsonRecord) => entry.settlementId === manualSettlementId),
		`manual cash list missing created settlement: ${manualCashListInitial.status} ${manualCashListInitial.text}`
	);

	const manualCashConfirmCreator = await fetchJson(
		`${baseUrl}/api/manual-cash/${encodeURIComponent(manualSettlementId)}/confirm`,
		{
			method: 'POST',
			headers: authHeaders,
			body: JSON.stringify({})
		}
	);
	assert(
		manualCashConfirmCreator.ok && manualCashConfirmCreator.data.settlement?.status === 'confirmed_by_creator',
		`creator confirm failed: ${manualCashConfirmCreator.status} ${manualCashConfirmCreator.text}`
	);

	const manualCashConfirmCounterparty = await fetchJson(
		`${baseUrl}/api/manual-cash/${encodeURIComponent(manualSettlementId)}/confirm`,
		{
			method: 'POST',
			headers: privateAuthHeaders,
			body: JSON.stringify({})
		}
	);
	assert(
		manualCashConfirmCounterparty.ok && manualCashConfirmCounterparty.data.settlement?.status === 'completed',
		`counterparty confirm failed: ${manualCashConfirmCounterparty.status} ${manualCashConfirmCounterparty.text}`
	);

	const manualCashListFinal = await fetchJson(`${baseUrl}/api/manual-cash/${encodeURIComponent(dmChannelId)}`, {
		headers: { Authorization: `Bearer ${privateToken}` }
	});
	assert(
		manualCashListFinal.ok &&
			Array.isArray(manualCashListFinal.data.items) &&
			manualCashListFinal.data.items.some(
				(entry: JsonRecord) => entry.settlementId === manualSettlementId && entry.status === 'completed'
			),
		`manual cash final list missing completed settlement: ${manualCashListFinal.status} ${manualCashListFinal.text}`
	);

	const offlineDonationCreate = await fetchJson(`${baseUrl}/api/admin/payments/donations/offline`, {
		method: 'POST',
		headers: authHeaders,
		body: JSON.stringify({
			amountMinor: 2200,
			currency: 'USD',
			donorLabel: 'Dot',
			description: 'Cash donation recorded by owner'
		})
	});
	assert(
		offlineDonationCreate.ok,
		`offline donation create failed: ${offlineDonationCreate.status} ${offlineDonationCreate.text}`
	);
	const offlineSettlementId = String(offlineDonationCreate.data.donation?.settlementId || '');
	assert(offlineSettlementId, 'offline donation create response missing settlementId');

	const offlineDonationAudit = await fetchJson(`${baseUrl}/api/admin/payments/donations/offline`, {
		headers: { Authorization: `Bearer ${token}` }
	});
	assert(
		offlineDonationAudit.ok &&
			Array.isArray(offlineDonationAudit.data.donations) &&
			offlineDonationAudit.data.donations.some(
				(entry: JsonRecord) => entry.settlementId === offlineSettlementId && entry.status === 'recorded'
			),
		`offline donation audit missing recorded entry: ${offlineDonationAudit.status} ${offlineDonationAudit.text}`
	);

	const donationSummaryWithOffline = await fetchJson(`${baseUrl}/api/payments/donations`);
	assert(
		donationSummaryWithOffline.ok &&
			Array.isArray(donationSummaryWithOffline.data.offlineTotals) &&
			donationSummaryWithOffline.data.offlineTotals.some((entry: JsonRecord) => Number(entry.amountMinor || 0) === 2200),
		`offline totals missing recorded donation: ${donationSummaryWithOffline.status} ${donationSummaryWithOffline.text}`
	);
	assert(
		Array.isArray(donationSummaryWithOffline.data.recentOfflineDonations) &&
			donationSummaryWithOffline.data.recentOfflineDonations.some(
				(entry: JsonRecord) => entry.settlementId === offlineSettlementId && entry.status === 'recorded'
			),
		'offline donation summary missing recorded ledger entry'
	);

	const offlineDonationVoid = await fetchJson(
		`${baseUrl}/api/admin/payments/donations/offline/${encodeURIComponent(offlineSettlementId)}/void`,
		{
			method: 'POST',
			headers: authHeaders,
			body: JSON.stringify({ reason: 'Smoke void' })
		}
	);
	assert(
		offlineDonationVoid.ok && offlineDonationVoid.data.donation?.status === 'voided',
		`offline donation void failed: ${offlineDonationVoid.status} ${offlineDonationVoid.text}`
	);

	const donationSummaryAfterOfflineVoid = await fetchJson(`${baseUrl}/api/payments/donations`);
	assert(
		donationSummaryAfterOfflineVoid.ok &&
			Array.isArray(donationSummaryAfterOfflineVoid.data.offlineTotals) &&
			!donationSummaryAfterOfflineVoid.data.offlineTotals.some(
				(entry: JsonRecord) => Number(entry.amountMinor || 0) >= 2200
			),
		`offline totals should not include voided donation: ${donationSummaryAfterOfflineVoid.status} ${donationSummaryAfterOfflineVoid.text}`
	);
	assert(
		Array.isArray(donationSummaryAfterOfflineVoid.data.recentOfflineDonations) &&
			donationSummaryAfterOfflineVoid.data.recentOfflineDonations.some(
				(entry: JsonRecord) => entry.settlementId === offlineSettlementId && entry.status === 'voided'
			),
		'offline donation summary missing voided ledger entry'
	);

	const privateIntent = await fetchJson(`${baseUrl}/api/payments/create`, {
		method: 'POST',
		headers: privateAuthHeaders,
		body: JSON.stringify({
			pluginId: 'th-payments',
			methodId: 'promptpay_qr',
			amountMinor: 4200,
			currency: 'THB',
			countryCode: 'TH',
			description: 'Private payment'
		})
	});
	assert(privateIntent.ok, `private payment create failed: ${privateIntent.status} ${privateIntent.text}`);

	const adminPeekPrivateIntent = await fetchJson(
		`${baseUrl}/api/payments/${encodeURIComponent(String(privateIntent.data.intent.intentId))}`,
		{
			headers: { Authorization: `Bearer ${token}` }
		}
	);
	assert(
		adminPeekPrivateIntent.status === 403,
		`admin should not access private direct payment: ${adminPeekPrivateIntent.status} ${adminPeekPrivateIntent.text}`
	);

	console.log(
		JSON.stringify(
			{
				ok: true,
				baseUrl,
				thaiProviderCount: Array.isArray(thaiProviders.data.providers) ? thaiProviders.data.providers.length : 0,
				westernProviderCount: Array.isArray(westernProviders.data.providers)
					? westernProviders.data.providers.length
					: 0,
				thaiIntentId: thaiIntent.data.intent?.intentId,
				westernIntentId: westernIntent.data.intent?.intentId,
				westernProviderIntentId: providerIntentId,
				donationIntentId: donationIntent.data.intent?.intentId,
				manualSettlementId,
				offlineSettlementId,
				privateIntentId: privateIntent.data.intent?.intentId
			},
			null,
			2
		)
	);
} catch (error) {
	console.error('[payments-local-e2e-smoke] FAIL', error);
	console.error(serverLog);
	process.exitCode = 1;
} finally {
	server.kill('SIGTERM');
	await Promise.race([
		new Promise<void>((resolve) => server.once('exit', () => resolve())),
		delay(3_000).then(() => undefined)
	]);
	if (!serverExited) {
		server.kill('SIGKILL');
	}
	fs.rmSync(smokeRoot, { recursive: true, force: true });
}
