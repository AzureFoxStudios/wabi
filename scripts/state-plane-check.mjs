#!/usr/bin/env node

const originRaw = (process.env.WABI_ORIGIN_URL || 'http://localhost:8080').trim();
const origin = originRaw.replace(/\/+$/, '');
const token = (process.env.WABI_AUTH_TOKEN || '').trim();
const strict = !['0', 'false', 'no', 'off'].includes((process.env.WABI_STATE_PLANE_STRICT || 'true').trim().toLowerCase());
const requireSignedHttp = !['0', 'false', 'no', 'off'].includes(
	(process.env.WABI_STATE_PLANE_REQUIRE_SIGNED_HTTP || 'false').trim().toLowerCase()
);

if (!token) {
	console.error('[state-plane-check] Missing WABI_AUTH_TOKEN');
	console.error('[state-plane-check] Example: WABI_ORIGIN_URL=http://localhost:8080 WABI_AUTH_TOKEN=<token> node scripts/state-plane-check.mjs');
	process.exit(2);
}

function toNumber(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function sum(values) {
	return values.reduce((acc, value) => acc + toNumber(value), 0);
}

async function main() {
	const response = await fetch(`${origin}/api/admin/state-plane`, {
		method: 'GET',
		headers: {
			Authorization: `Bearer ${token}`
		}
	});

	if (!response.ok) {
		const body = await response.text().catch(() => '');
		console.error(`[state-plane-check] Request failed: HTTP ${response.status}`);
		if (body) {
			console.error(body);
		}
		process.exit(2);
	}

	const payload = await response.json();
	const runtime = payload?.runtime || {};
	const config = runtime.config || {};
	const messageStore = runtime.messageStore || {};
	const channelStore = runtime.channelStore || {};
	const channelMemberStore = runtime.channelMemberStore || {};
	const userStore = runtime.userStore || {};
	const sessionStore = runtime.sessionStore || {};
	const rbacStore = runtime.rbacStore || {};
	const shadowWriter = runtime.shadowWriter || {};
	const watchdog = runtime.watchdog || {};
	const reducerIngress = runtime.reducerIngress || {};
	const schema = runtime.schema || {};
	const warmup = runtime.warmup || {};
	const readSwitchStats = {
		message: messageStore?.readSwitch || {},
		channel: channelStore?.readSwitch || {},
		channelMember: channelMemberStore?.readSwitch || {},
		user: userStore?.readSwitch || {},
		session: sessionStore?.readSwitch || {},
		rbac: rbacStore?.readSwitch || {}
	};

	const parityMismatches = {
		message: toNumber(messageStore?.parity?.mismatches),
		channel: toNumber(channelStore?.parity?.mismatches),
		channelMember: toNumber(channelMemberStore?.parity?.mismatches),
		user: toNumber(userStore?.parity?.mismatches),
		session: toNumber(sessionStore?.parity?.mismatches),
		rbac: toNumber(rbacStore?.parity?.mismatches)
	};

	const shadowWriteFailures = {
		message: toNumber(messageStore?.shadow?.writesFailed),
		channel: toNumber(channelStore?.shadow?.writesFailed),
		channelMember: toNumber(channelMemberStore?.shadow?.writesFailed),
		user: toNumber(userStore?.shadow?.writesFailed),
		session: toNumber(sessionStore?.shadow?.writesFailed),
		rbac: toNumber(rbacStore?.shadow?.writesFailed)
	};

	const readCanaryFailures = {
		message: toNumber(readSwitchStats.message.mismatches) + toNumber(readSwitchStats.message.shadowErrors),
		channel: toNumber(readSwitchStats.channel.mismatches) + toNumber(readSwitchStats.channel.shadowErrors),
		channelMember:
			toNumber(readSwitchStats.channelMember.mismatches) + toNumber(readSwitchStats.channelMember.shadowErrors),
		user: toNumber(readSwitchStats.user.mismatches) + toNumber(readSwitchStats.user.shadowErrors),
		session: toNumber(readSwitchStats.session.mismatches) + toNumber(readSwitchStats.session.shadowErrors),
		rbac: toNumber(readSwitchStats.rbac.mismatches) + toNumber(readSwitchStats.rbac.shadowErrors)
	};

	const totals = {
		parityMismatches: sum(Object.values(parityMismatches)),
		shadowWriteFailures: sum(Object.values(shadowWriteFailures)),
		readCanaryFailures: sum(Object.values(readCanaryFailures)),
		outboxErrors: toNumber(runtime.outbox?.errors),
		shadowWriterFailures: toNumber(shadowWriter.failed) + toNumber(shadowWriter.parseErrors) + toNumber(shadowWriter.loopErrors),
		shadowWriterBacklogOverLimit: Boolean(shadowWriter.backlogOverLimit) ? 1 : 0,
		schemaMismatch: Boolean(schema.mismatch) ? 1 : 0,
		unsignedHttpSink:
			requireSignedHttp &&
			Boolean(shadowWriter.enabled) &&
			shadowWriter.sink === 'http' &&
			!Boolean(shadowWriter.signingEnabled)
				? 1
				: 0,
		watchdogAlerts: toNumber(watchdog.alerts),
		warmupFailures: Boolean(warmup.enabled) && warmup.success === false ? 1 : 0
	};

	console.log('[state-plane-check] Runtime Summary');
	const requestedMode = config.mode || 'unknown';
	const effectiveMode = config.effectiveMode || requestedMode;
	console.log(`  mode=${requestedMode} effective=${effectiveMode} read=${config.stdbReadEnabled} write=${config.stdbWriteEnabled} strict=${config.strictMode}`);
	console.log(`  check.strict=${strict} check.requireSignedHttp=${requireSignedHttp}`);
	if (config.modeFallbackReason) {
		console.log(`  modeFallbackReason=${config.modeFallbackReason}`);
	}
	console.log(`  outbox=${runtime.outbox?.path || 'disabled'} written=${toNumber(runtime.outbox?.written)} errors=${toNumber(runtime.outbox?.errors)} redactSensitive=${Boolean(runtime.outbox?.redactSensitive)} redactedFields=${toNumber(runtime.outbox?.redactedFields)}`);
	console.log(`  shadowWriter enabled=${Boolean(shadowWriter.enabled)} running=${Boolean(shadowWriter.running)} sink=${shadowWriter.sink || 'n/a'} signingEnabled=${Boolean(shadowWriter.signingEnabled)} signingKeyId=${shadowWriter.signingKeyId || ''} commandConfigured=${Boolean(shadowWriter.commandConfigured)} commandTimeoutMs=${toNumber(shadowWriter.commandTimeoutMs)} applied=${toNumber(shadowWriter.applied)} failed=${toNumber(shadowWriter.failed)} parseErrors=${toNumber(shadowWriter.parseErrors)} loopErrors=${toNumber(shadowWriter.loopErrors)} duplicatesSkipped=${toNumber(shadowWriter.duplicatesSkipped)} backlogBytes=${toNumber(shadowWriter.backlogBytes)} backlogOverLimit=${Boolean(shadowWriter.backlogOverLimit)} maxBacklogBytes=${toNumber(shadowWriter.outboxMaxBytes)} truncations=${toNumber(shadowWriter.truncations)} truncateBytes=${toNumber(shadowWriter.truncateBytes)} truncateFailures=${toNumber(shadowWriter.truncateFailures)} truncateMinBytes=${toNumber(shadowWriter.outboxTruncateMinBytes)}`);
	console.log(`  reducerIngress enabled=${Boolean(reducerIngress.enabled)} path=${reducerIngress.path || ''} requireSignature=${Boolean(reducerIngress.requireSignature)} requireBearerToken=${Boolean(reducerIngress.requireBearerToken)} accepted=${toNumber(reducerIngress.accepted)} duplicates=${toNumber(reducerIngress.duplicates)} rejected=${toNumber(reducerIngress.rejected)} rejectedAuth=${toNumber(reducerIngress.rejectedAuth)} rejectedSignature=${toNumber(reducerIngress.rejectedSignature)} rejectedReplay=${toNumber(reducerIngress.rejectedReplay)} rejectedParse=${toNumber(reducerIngress.rejectedParse)} errors=${toNumber(reducerIngress.errors)}`);
	console.log(`  schema requiredVersion=${toNumber(schema.requiredVersion)} currentVersion=${toNumber(schema.currentVersion)} autoApply=${Boolean(schema.autoApply)} mismatch=${Boolean(schema.mismatch)} updated=${Boolean(schema.updated)} reason=${schema.reason || ''} path=${schema.path || ''}`);
	console.log(`  warmup enabled=${Boolean(warmup.enabled)} running=${Boolean(warmup.running)} success=${warmup.success === true ? 'true' : warmup.success === false ? 'false' : 'null'} limit=${toNumber(warmup.limit)} startedAt=${toNumber(warmup.startedAt)} completedAt=${toNumber(warmup.completedAt)} lastError=${warmup.lastError || ''}`);
	console.log(`  watchdog enabled=${Boolean(watchdog.enabled)} running=${Boolean(watchdog.running)} checks=${toNumber(watchdog.checks)} alerts=${toNumber(watchdog.alerts)}`);
	console.log(`  readSwitch.message enabled=${Boolean(readSwitchStats.message.enabled)} canaryPercent=${toNumber(readSwitchStats.message.canaryPercent)} attempts=${toNumber(readSwitchStats.message.attempts)} routed=${toNumber(readSwitchStats.message.canaryRouted)} shadowServed=${toNumber(readSwitchStats.message.shadowServed)} mismatches=${toNumber(readSwitchStats.message.mismatches)} shadowErrors=${toNumber(readSwitchStats.message.shadowErrors)} fallbacks=${toNumber(readSwitchStats.message.fallbacks)}`);
	console.log(`  readSwitch.channel enabled=${Boolean(readSwitchStats.channel.enabled)} canaryPercent=${toNumber(readSwitchStats.channel.canaryPercent)} attempts=${toNumber(readSwitchStats.channel.attempts)} routed=${toNumber(readSwitchStats.channel.canaryRouted)} shadowServed=${toNumber(readSwitchStats.channel.shadowServed)} mismatches=${toNumber(readSwitchStats.channel.mismatches)} shadowErrors=${toNumber(readSwitchStats.channel.shadowErrors)} fallbacks=${toNumber(readSwitchStats.channel.fallbacks)}`);
	console.log(`  readSwitch.channelMember enabled=${Boolean(readSwitchStats.channelMember.enabled)} canaryPercent=${toNumber(readSwitchStats.channelMember.canaryPercent)} attempts=${toNumber(readSwitchStats.channelMember.attempts)} routed=${toNumber(readSwitchStats.channelMember.canaryRouted)} shadowServed=${toNumber(readSwitchStats.channelMember.shadowServed)} mismatches=${toNumber(readSwitchStats.channelMember.mismatches)} shadowErrors=${toNumber(readSwitchStats.channelMember.shadowErrors)} fallbacks=${toNumber(readSwitchStats.channelMember.fallbacks)}`);
	console.log(`  readSwitch.user enabled=${Boolean(readSwitchStats.user.enabled)} canaryPercent=${toNumber(readSwitchStats.user.canaryPercent)} attempts=${toNumber(readSwitchStats.user.attempts)} routed=${toNumber(readSwitchStats.user.canaryRouted)} shadowServed=${toNumber(readSwitchStats.user.shadowServed)} mismatches=${toNumber(readSwitchStats.user.mismatches)} shadowErrors=${toNumber(readSwitchStats.user.shadowErrors)} fallbacks=${toNumber(readSwitchStats.user.fallbacks)}`);
	console.log(`  readSwitch.session enabled=${Boolean(readSwitchStats.session.enabled)} canaryPercent=${toNumber(readSwitchStats.session.canaryPercent)} attempts=${toNumber(readSwitchStats.session.attempts)} routed=${toNumber(readSwitchStats.session.canaryRouted)} shadowServed=${toNumber(readSwitchStats.session.shadowServed)} mismatches=${toNumber(readSwitchStats.session.mismatches)} shadowErrors=${toNumber(readSwitchStats.session.shadowErrors)} fallbacks=${toNumber(readSwitchStats.session.fallbacks)}`);
	console.log(`  readSwitch.rbac enabled=${Boolean(readSwitchStats.rbac.enabled)} canaryPercent=${toNumber(readSwitchStats.rbac.canaryPercent)} attempts=${toNumber(readSwitchStats.rbac.attempts)} routed=${toNumber(readSwitchStats.rbac.canaryRouted)} shadowServed=${toNumber(readSwitchStats.rbac.shadowServed)} mismatches=${toNumber(readSwitchStats.rbac.mismatches)} shadowErrors=${toNumber(readSwitchStats.rbac.shadowErrors)} fallbacks=${toNumber(readSwitchStats.rbac.fallbacks)}`);
	console.log('  parity mismatches:', JSON.stringify(parityMismatches));
	console.log('  shadow write failures:', JSON.stringify(shadowWriteFailures));
	console.log('  read canary failures:', JSON.stringify(readCanaryFailures));
	console.log('  totals:', JSON.stringify(totals));

	const hasIssues =
		totals.parityMismatches > 0 ||
		totals.shadowWriteFailures > 0 ||
		totals.readCanaryFailures > 0 ||
		totals.outboxErrors > 0 ||
		totals.shadowWriterFailures > 0 ||
		totals.shadowWriterBacklogOverLimit > 0 ||
		totals.schemaMismatch > 0 ||
		totals.unsignedHttpSink > 0 ||
		totals.warmupFailures > 0;

	if (hasIssues) {
		const message = '[state-plane-check] Drift/failures detected';
		if (strict) {
			console.error(message);
			process.exit(1);
		}
		console.warn(`${message} (strict mode disabled, exiting 0)`);
	}
}

main().catch((error) => {
	console.error('[state-plane-check] Unhandled error:', error);
	process.exit(2);
});
