<script lang="ts">
	import { onMount } from 'svelte';
	import { io } from 'socket.io-client';

	let logs: string[] = [];
	let socketConnected = false;
	let socketId = '';
	let jsWorking = false;

	function addLog(message: string) {
		logs = [...logs, `[${new Date().toLocaleTimeString()}] ${message}`];
		console.log(message);
	}

	onMount(() => {
		jsWorking = true;
		addLog('✅ JavaScript IS WORKING! onMount fired');
		addLog('Starting socket connection test...');

		// Detect server URL
		let serverUrl = 'http://localhost:3000';
		const origin = window.location.origin;
		if (!origin.includes(':5173')) {
			serverUrl = origin;
		}

		addLog(`Connecting to: ${serverUrl}`);

		const socket = io(serverUrl, {
			reconnectionDelay: 1000,
			reconnectionDelayMax: 5000,
			timeout: 10000
		});

		socket.on('connect', () => {
			socketConnected = true;
			socketId = socket.id || '';
			addLog(`✅ CONNECTED! Socket ID: ${socketId}`);

			const username = `TestUser${Math.floor(Math.random() * 1000)}`;
			addLog(`Sending 'join' event with username: ${username}`);
			socket.emit('join', username);
		});

		socket.on('connect_error', (error) => {
			addLog(`❌ Connection Error: ${error.message}`);
		});

		socket.on('connect_timeout', () => {
			addLog('⏱️ Connection Timeout');
		});

		socket.on('init', (data: any) => {
			addLog(`✅ Received 'init' event!`);
			addLog(`  - Channels: ${data.channels?.length || 0}`);
			addLog(`  - Users: ${data.users?.length || 0}`);
			addLog(`  - Current user found: ${data.users?.some((u: any) => u.id === socket.id) ? 'YES' : 'NO'}`);
		});

		socket.on('disconnect', () => {
			socketConnected = false;
			addLog('❌ Disconnected from server');
		});

		return () => {
			socket.disconnect();
		};
	});
</script>

<div class="diagnostic-page">
	<h1>Socket Connection Diagnostic</h1>

	<div class="status-grid">
		<div class="status-card" class:success={jsWorking}>
			<h2>JavaScript</h2>
			<p class="status-text">{jsWorking ? '✅ Working' : '❌ Not Working'}</p>
		</div>

		<div class="status-card" class:success={socketConnected}>
			<h2>Socket Connection</h2>
			<p class="status-text">{socketConnected ? '✅ Connected' : '⏳ Connecting...'}</p>
			{#if socketId}
				<p class="detail">ID: {socketId}</p>
			{/if}
		</div>
	</div>

	<div class="logs-container">
		<h2>Connection Log</h2>
		<div class="logs">
			{#each logs as log}
				<div class="log-entry">{log}</div>
			{/each}
		</div>
	</div>

	<div class="actions">
		<a href="/">← Back to Main App</a>
	</div>
</div>

<style>
	.diagnostic-page {
		padding: 2rem;
		max-width: 1200px;
		margin: 0 auto;
		background-color: #1a1a1a;
		min-height: 100vh;
		color: #fff;
	}

	h1 {
		text-align: center;
		margin-bottom: 2rem;
		color: #5865f2;
	}

	.status-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
		gap: 1rem;
		margin-bottom: 2rem;
	}

	.status-card {
		background-color: #2a2a2a;
		border: 2px solid #444;
		border-radius: 8px;
		padding: 1.5rem;
		text-align: center;
	}

	.status-card.success {
		border-color: #4CAF50;
		background-color: #1b3a1b;
	}

	.status-card h2 {
		margin: 0 0 1rem 0;
		font-size: 1.2rem;
	}

	.status-text {
		font-size: 1.5rem;
		font-weight: bold;
		margin: 0;
	}

	.detail {
		margin-top: 0.5rem;
		font-size: 0.9rem;
		color: #aaa;
	}

	.logs-container {
		background-color: #0a0a0a;
		border: 1px solid #333;
		border-radius: 8px;
		padding: 1rem;
		margin-bottom: 2rem;
	}

	.logs-container h2 {
		margin: 0 0 1rem 0;
		font-size: 1.1rem;
	}

	.logs {
		max-height: 400px;
		overflow-y: auto;
		font-family: monospace;
		font-size: 0.9rem;
	}

	.log-entry {
		padding: 0.3rem 0;
		border-bottom: 1px solid #222;
	}

	.log-entry:last-child {
		border-bottom: none;
	}

	.actions {
		text-align: center;
	}

	.actions a {
		color: #5865f2;
		text-decoration: none;
		font-size: 1.1rem;
	}

	.actions a:hover {
		text-decoration: underline;
	}
</style>
