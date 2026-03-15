param(
	[ValidateSet('dual_write', 'stdb_primary')]
	[string]$Mode = 'dual_write',
	[string]$Database = 'wabi-state-benchmark',
	[string]$StdbServer = 'http://127.0.0.1:3100',
	[string]$BridgeServer = 'http://host.docker.internal:3100',
	[int]$PollIntervalMs = 250,
	[int]$BatchSize = 500,
	[string]$Channel = 'stdb-benchmark',
	[int]$Messages = 25,
	[int]$Warmup = 3,
	[int]$PowerUsers = 4,
	[int]$PowerMessages = 8,
	[int]$DirectStdbSamples = 10,
	[int]$EchoTimeoutMs = 60000,
	[int]$PersistTimeoutMs = 10000,
	[string]$Username = '',
	[string]$Password = '',
	[string]$Token = '',
	[string]$AdminToken = '',
	[string]$AdminUsername = '',
	[string]$StdbAuthToken = '',
	[string]$Origin = 'http://localhost:8080',
	[switch]$AutoUser = $true,
	[switch]$DisableLegacyMirror,
	[switch]$SkipPublish,
	[switch]$NoBuild,
	[switch]$Json,
	[switch]$NoBenchmark
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

if ($PollIntervalMs -lt 250) {
	$PollIntervalMs = 250
}

function Invoke-Step {
	param(
		[string]$Label,
		[scriptblock]$Action
	)
	Write-Host "[stdb-benchmark] $Label"
	& $Action
}

function New-RandomString {
	param([int]$Length = 12)
	$alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
	$builder = New-Object System.Text.StringBuilder
	for ($i = 0; $i -lt $Length; $i++) {
		[void]$builder.Append($alphabet[(Get-Random -Minimum 0 -Maximum $alphabet.Length)])
	}
	return $builder.ToString()
}

function Invoke-JsonRequest {
	param(
		[string]$Method,
		[string]$Url,
		[object]$Body = $null,
		[hashtable]$Headers = @{}
	)

	$params = @{
		Method = $Method
		Uri = $Url
		Headers = $Headers
	}

	if ($null -ne $Body) {
		$params.ContentType = 'application/json'
		$params.Body = ($Body | ConvertTo-Json -Depth 10 -Compress)
	}

	return Invoke-RestMethod @params
}

function New-BenchmarkUser {
	param([string]$BaseOrigin)

	$username = "stdbbench_" + (New-RandomString -Length 10)
	$password = "Bench!" + (New-RandomString -Length 18)
	$handle = $username

	$response = Invoke-JsonRequest -Method 'Post' -Url "$BaseOrigin/api/auth/register" -Body @{
		username = $username
		password = $password
		handle = $handle
	}

	return @{
		Username = $response.user.username
		Password = $password
		Token = $response.token
	}
}

function Ensure-BenchmarkChannel {
	param(
		[string]$RepoRoot,
		[string]$ChannelId
	)

	$command = @'
import path from "path";
import Database from "./backend/node_modules/better-sqlite3/lib/index.js";

const [repoRoot, channelId] = process.argv.slice(2);
const dbPath = path.join(repoRoot, "data", "chat.db");
const db = new Database(dbPath);
const now = Date.now();

const existing = db.prepare(`
	SELECT channel_id, created_at
	FROM channels
	WHERE channel_id = ?
	LIMIT 1
`).get(channelId);

if (existing?.channel_id) {
	db.prepare(`
		UPDATE channels
		SET channel_type = ?,
			name = ?,
			description = ?,
			min_role = ?,
			persist_messages = 1,
			is_archived = 0,
			watch_queue_enabled = COALESCE(watch_queue_enabled, 0)
		WHERE channel_id = ?
	`).run('text', channelId, '', 'guest', channelId);
} else {
	db.prepare(`
		INSERT INTO channels (
			channel_id, channel_type, name, description, min_role, created_at, created_by, persist_messages, watch_queue_enabled,
			is_archived, parent_channel_id, is_breakout, breakout_index, parent_message_id, thread_archived, thread_locked,
			thread_auto_archive_minutes, thread_last_activity_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, NULL, NULL, 0, 0, 1440, ?)
	`).run(channelId, 'text', channelId, '', 'guest', now, 'state-plane-benchmark', 1, 0, now);
}

db.close();
process.stdout.write(JSON.stringify({
	channelId,
	created: !existing?.channel_id,
	persistMessages: true
}));
'@

	$output = $command | node --input-type=module - $RepoRoot $ChannelId
	return ($output | Out-String | ConvertFrom-Json)
}

function Wait-BackendHealthy {
	param(
		[string]$BaseOrigin,
		[int]$TimeoutSeconds = 60
	)

	$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
	while ((Get-Date) -lt $deadline) {
		try {
			$response = Invoke-WebRequest -UseBasicParsing -Uri "$BaseOrigin/health" -TimeoutSec 5
			if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
				return
			}
		} catch {
			Start-Sleep -Milliseconds 500
			continue
		}
		Start-Sleep -Milliseconds 500
	}

	throw "Backend did not become healthy within ${TimeoutSeconds}s at $BaseOrigin/health"
}

function Get-AdminIdentity {
	param(
		[string]$RepoRoot,
		[string]$Mode,
		[string]$StdbServer,
		[string]$Database
	)

	$command = @'
import crypto from "crypto";
import fs from "fs";
import path from "path";
import jwt from "./backend/node_modules/jsonwebtoken/index.js";
import Database from "./backend/node_modules/better-sqlite3/lib/index.js";

const [repoRoot, mode, stdbServerRaw, stdbDatabase] = process.argv.slice(2);
const envPath = path.join(repoRoot, ".env");
const dbPath = path.join(repoRoot, "data", "chat.db");
const envText = fs.readFileSync(envPath, "utf8");
const secretLine = envText.split(/\r?\n/).find((line) => line.startsWith("JWT_SECRET="));
if (!secretLine) {
	throw new Error("JWT_SECRET missing from .env");
}
const secret = secretLine.slice("JWT_SECRET=".length).trim();
if (!secret) {
	throw new Error("JWT_SECRET is blank");
}

const db = new Database(dbPath);

function normalizeServer(raw) {
	const value = String(raw || "").trim();
	if (!value) return "";
	if (value.toLowerCase() === "local") return "http://127.0.0.1:3000";
	if (value.toLowerCase() === "maincloud") return "https://maincloud.spacetimedb.com";
	if (value.includes("://")) return value.replace(/\/+$/, "");
	return `http://${value.replace(/\/+$/, "")}`;
}

function decodeCell(value) {
	if (Array.isArray(value) && value.length >= 2 && value[0] === 0) {
		return value[1];
	}
	return value;
}

function firstRow(payload) {
	if (Array.isArray(payload) && payload.length > 0 && Array.isArray(payload[0]?.rows)) {
		return payload[0].rows[0] || null;
	}
	return null;
}

async function stdbIdentity(server) {
	const response = await fetch(`${server}/v1/identity`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: "{}"
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`stdb_identity_${response.status}: ${text || response.statusText}`);
	}
	const json = text ? JSON.parse(text) : {};
	const token = typeof json?.token === "string" ? json.token.trim() : "";
	if (!token) {
		throw new Error("stdb_identity_missing_token");
	}
	return token;
}

async function stdbSql(server, database, token, query) {
	const response = await fetch(`${server}/v1/database/${encodeURIComponent(database)}/sql`, {
		method: "POST",
		headers: {
			"Content-Type": "text/plain",
			Authorization: `Bearer ${token}`
		},
		body: query
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`stdb_sql_${response.status}: ${text || response.statusText}`);
	}
	return text ? JSON.parse(text) : null;
}

async function stdbCall(server, database, token, reducer, args) {
	const response = await fetch(`${server}/v1/database/${encodeURIComponent(database)}/call/${encodeURIComponent(reducer)}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`
		},
		body: JSON.stringify(args)
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`stdb_call_${response.status}: ${text || response.statusText}`);
	}
	return text ? JSON.parse(text) : null;
}

async function findStdbAdminUser(server, database, token) {
	const rolePayload = await stdbSql(
		server,
		database,
		token,
		"SELECT user_id, role FROM state_rbac_assignment WHERE workspace_id = 'default-workspace' AND active = true AND (role = 'owner' OR role = 'admin') LIMIT 20"
	);
	const rows = Array.isArray(rolePayload?.[0]?.rows) ? rolePayload[0].rows : [];
	const orderedUserIds = rows
		.map((row) => ({
			userId: Number(row?.[0]),
			role: String(row?.[1] || "")
		}))
		.filter((entry) => Number.isFinite(entry.userId) && entry.userId > 0)
		.sort((a, b) => {
			const rank = (role) => role === "owner" ? 0 : role === "admin" ? 1 : 2;
			return rank(a.role) - rank(b.role) || a.userId - b.userId;
		});

	for (const entry of orderedUserIds) {
		const userPayload = await stdbSql(
			server,
			database,
			token,
			`SELECT row_json FROM state_user WHERE user_id = ${entry.userId} AND deleted = false AND active = true LIMIT 1`
		);
		const row = firstRow(userPayload);
		const rowJson = decodeCell(row?.[0]);
		if (typeof rowJson !== "string" || !rowJson.trim()) continue;
		const parsed = JSON.parse(rowJson);
		return {
			userId: entry.userId,
			username: String(parsed?.username || "").trim(),
			color: String(parsed?.color || "#4ECDC4"),
			profilePicture: typeof parsed?.profile_picture === "string" ? parsed.profile_picture : null
		};
	}

	return null;
}

function findLegacyAdminUser() {
	const explicit = db.prepare(`
		SELECT u.user_id, u.username, u.color, u.profile_picture
		FROM users u
		LEFT JOIN user_roles ur ON ur.user_id = u.user_id
		WHERE COALESCE(u.is_active, 1) = 1
		  AND (
			(ur.workspace_id = 'default-workspace' AND ur.role_name IN ('owner', 'admin'))
			OR u.user_id = 1
		  )
		ORDER BY
			CASE ur.role_name
				WHEN 'owner' THEN 0
				WHEN 'admin' THEN 1
				ELSE 2
			END,
			u.user_id ASC
		LIMIT 1
	`).get();
	if (explicit?.user_id && explicit?.username) {
		return explicit;
	}
	const fallback = db.prepare(`
		SELECT user_id, username, color, profile_picture
		FROM users
		WHERE COALESCE(is_active, 1) = 1
		ORDER BY user_id ASC
		LIMIT 1
	`).get();
	return fallback || null;
}

async function main() {
	const normalizedServer = normalizeServer(stdbServerRaw);
	let adminUser = null;
	let stdbToken = "";

	if (mode === "stdb_primary") {
		if (!normalizedServer || !stdbDatabase) {
			throw new Error("stdb_primary admin bootstrap requires STDB server and database");
		}
		stdbToken = await stdbIdentity(normalizedServer);
		adminUser = await findStdbAdminUser(normalizedServer, stdbDatabase, stdbToken);
		if (!adminUser) {
			throw new Error("No active owner/admin user found in STDB state");
		}
	} else {
		adminUser = findLegacyAdminUser();
		if (!adminUser) {
			throw new Error("No active admin-capable user found in SQLite");
		}
	}

	const userId = Number(adminUser.userId || adminUser.user_id || 0);
	const username = String(adminUser.username || "").trim();
	const color = String(adminUser.color || "#4ECDC4");
	const profilePicture = typeof adminUser.profilePicture === "string"
		? adminUser.profilePicture
		: (typeof adminUser.profile_picture === "string" ? adminUser.profile_picture : null);
	if (!Number.isFinite(userId) || userId <= 0 || !username) {
		throw new Error("Admin bootstrap resolved an invalid user");
	}

	const sessionId = `reg-${Date.now()}-${crypto.randomBytes(18).toString("base64url")}`;
	const createdAt = Date.now();
	const expiresAt = createdAt + (30 * 24 * 60 * 60 * 1000);
	const session = {
		session_id: sessionId,
		user_id: userId,
		username,
		color,
		profile_picture: profilePicture,
		created_at: createdAt,
		expires_at: expiresAt,
		is_temporary: 0
	};

	db.prepare(`
		INSERT INTO sessions (session_id, user_id, username, color, profile_picture, created_at, expires_at, is_temporary, socket_id, last_seen)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
	`).run(
		session.session_id,
		session.user_id,
		session.username,
		session.color,
		session.profile_picture,
		session.created_at,
		session.expires_at,
		session.is_temporary
	);

	if (mode === "stdb_primary") {
		const event = {
			eventId: `bootstrap:session:${sessionId}`,
			timestamp: createdAt,
			entity: "session",
			operation: "create",
			payload: {
				sessionId,
				userId,
				isTemporary: false,
				row: session
			}
		};
		await stdbCall(normalizedServer, stdbDatabase, stdbToken, "ingest_wabi_event", [JSON.stringify(event)]);
	}

	const token = jwt.sign(
		{ sessionId, userId, isTemporary: false },
		secret,
		{ expiresIn: "30d" }
	);

	process.stdout.write(JSON.stringify({
		token,
		username,
		userId,
		sessionId,
		sourceMode: mode
	}));
}

try {
	await main();
} finally {
	db.close();
}
'@

	$output = $command | node --input-type=module - $RepoRoot $Mode $StdbServer $Database
	return ($output | Out-String | ConvertFrom-Json)
}

if (-not $SkipPublish) {
	Invoke-Step "Publishing SpacetimeDB module to '$Database'" {
		$publishArgs = @('publish', '-p', 'spacetimedb/wabi_state_bridge', '-s', $StdbServer, '--yes', '--no-config', $Database)
		if ($StdbAuthToken) {
			$publishArgs += @('--token', $StdbAuthToken)
		} else {
			$publishArgs += '--anonymous'
		}
		& spacetime @publishArgs
	}
}

$env:STATE_BACKEND_MODE = $Mode
$env:STATE_STDB_WRITE_ENABLED = 'true'
$env:STATE_STDB_READ_ENABLED = if ($Mode -eq 'stdb_primary') { 'true' } else { 'false' }
$env:STATE_STDB_PRIMARY_MIRROR_LEGACY_WRITES = if ($Mode -eq 'stdb_primary' -and $DisableLegacyMirror) { 'false' } else { 'true' }
$env:STATE_BACKEND_STRICT = 'false'
$env:STATE_SHADOW_WRITER_ENABLED = if ($Mode -eq 'dual_write') { 'true' } else { 'false' }
$env:STATE_SHADOW_SINK = 'stdb'
$env:STATE_SHADOW_POLL_INTERVAL_MS = [string]$PollIntervalMs
$env:STATE_SHADOW_BATCH_SIZE = [string]$BatchSize
$env:WABI_STDB_BRIDGE_SERVER = $BridgeServer
$env:WABI_STDB_BRIDGE_DATABASE = $Database
$env:WABI_STDB_AUTH_TOKEN = $StdbAuthToken
$env:WABI_STDB_ANONYMOUS = if ($StdbAuthToken) { 'false' } else { 'true' }
$env:WABI_STDB_ALLOW_ANONYMOUS_IN_PRODUCTION = if ($StdbAuthToken) { 'false' } else { 'true' }

Invoke-Step "Ensuring benchmark channel '$Channel' is persistent before boot" {
	$channelState = Ensure-BenchmarkChannel -RepoRoot $repoRoot -ChannelId $Channel
	Write-Host "  created=$($channelState.created) persistMessages=$($channelState.persistMessages)"
}

$composeArgs = @('compose', 'up', '-d')
if (-not $NoBuild) {
	$composeArgs += '--build'
}
$composeArgs += 'backend'

Invoke-Step "Starting backend in $Mode" {
	& docker @composeArgs
}

$effectiveOrigin = $Origin.TrimEnd('/')

Invoke-Step "Waiting for backend health at $effectiveOrigin/health" {
	Wait-BackendHealthy -BaseOrigin $effectiveOrigin
}

Write-Host "[stdb-benchmark] Backend ready:"
Write-Host "  mode=$Mode"
Write-Host "  shadowSink=stdb"
Write-Host "  legacyMirror=$(if ($Mode -eq 'stdb_primary' -and $DisableLegacyMirror) { 'off' } else { 'on' })"
Write-Host "  STDB server=$StdbServer"
Write-Host "  STDB database=$Database"

if (-not $Token -and -not ($Username -and $Password) -and $AutoUser) {
	Invoke-Step "Creating disposable benchmark user via $effectiveOrigin" {
		try {
			$created = New-BenchmarkUser -BaseOrigin $effectiveOrigin
			$script:Username = $created.Username
			$script:Password = $created.Password
			$script:Token = $created.Token
		} catch {
			$script:Username = "stdbguest_" + (New-RandomString -Length 10)
			$script:Password = ''
			$script:Token = ''
			Write-Host "  registration limited; falling back to guest benchmark user"
		}
	}
	Write-Host "  benchmarkUser=$Username"
}

if (-not $AdminToken) {
	Invoke-Step 'Generating admin probe identity for the active store' {
		$identity = Get-AdminIdentity -RepoRoot $repoRoot -Mode $Mode -StdbServer $StdbServer -Database $Database
		$script:AdminToken = $identity.token
		if (-not $AdminUsername) {
			$script:AdminUsername = $identity.username
		}
	}
}

$benchmarkArgs = @(
	'frontend/scripts/state-plane-benchmark.mjs',
	'--origin', $effectiveOrigin,
	'--channel', $Channel,
	'--messages', [string]$Messages,
	'--warmup', [string]$Warmup,
	'--power-users', [string]$PowerUsers,
	'--power-messages', [string]$PowerMessages,
	'--direct-stdb-samples', [string]$DirectStdbSamples,
	'--echo-timeout-ms', [string]$EchoTimeoutMs,
	'--persist-timeout-ms', [string]$PersistTimeoutMs,
	'--stdb-server', $StdbServer,
	'--stdb-database', $Database
)

if ($Json) {
	$benchmarkArgs += '--json'
}

if ($Token) {
	$benchmarkArgs += @('--token', $Token)
}
if ($Username) {
	$benchmarkArgs += @('--username', $Username)
}
if ($Password) {
	$benchmarkArgs += @('--password', $Password)
}
if ($AdminToken) {
	$benchmarkArgs += @('--admin-token', $AdminToken)
}
if ($AdminUsername) {
	$benchmarkArgs += @('--admin-username', $AdminUsername)
}
if ($Mode -eq 'stdb_primary' -and $DisableLegacyMirror) {
	$benchmarkArgs += '--no-sqlite-probe'
}

if ($NoBenchmark) {
	Write-Host '[stdb-benchmark] Benchmark step skipped.'
} elseif ($Username) {
	Invoke-Step "Running benchmark" {
		& node @benchmarkArgs
	}
} else {
	Write-Host "[stdb-benchmark] To run the benchmark:"
	$example = @('node') + $benchmarkArgs + @('--username', '<user>')
	Write-Host "  $($example -join ' ')"
}
