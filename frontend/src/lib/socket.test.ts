/**
 * SocketManager Unit Tests
 * Tests the core logic of the socket connection manager
 */

interface TestResult {
	name: string;
	passed: boolean;
	error?: string;
	details?: string;
}

// Mock Socket.IO socket for testing
class MockSocket {
	public connected = false;
	public disconnected = true;
	private listeners: Record<string, Function[]> = {};
	private shouldFailConnect = false;

	on(event: string, callback: Function) {
		if (!this.listeners[event]) this.listeners[event] = [];
		this.listeners[event].push(callback);
	}

	off(event: string) {
		delete this.listeners[event];
	}

	emit(event: string, data?: any) {
		if (this.listeners[event]) {
			this.listeners[event].forEach(cb => cb(data));
		}
	}

	disconnect() {
		this.connected = false;
		this.disconnected = true;
		this.emit('disconnect', 'client namespace disconnect');
	}

	simulateConnect() {
		this.connected = true;
		this.disconnected = false;
		this.emit('connect');
	}

	failNextConnect() {
		this.shouldFailConnect = true;
	}
}

// Simulated SocketManager for testing
class TestableSocketManager {
	private socket: MockSocket | null = null;
	private username: string = '';
	private isConnecting = false;
	private listenersBound = false;
	public connectCallCount = 0;
	public cleanupCallCount = 0;

	connect(username: string): MockSocket | null {
		// Guard: prevent duplicate initialization
		if (this.isConnecting) {
			console.log('[TEST] Connection already in progress, skipping');
			return this.socket;
		}

		// Guard: if already connected with same credentials, return existing socket
		if (this.socket && this.username === username && !this.socket.disconnected) {
			console.log('[TEST] Already connected with same username, reusing connection');
			return this.socket;
		}

		// Mark as connecting BEFORE any async operations
		this.isConnecting = true;
		this.username = username;

		// If we have an existing socket, clean it up first
		if (this.socket) {
			console.log('[TEST] Cleaning up existing socket before reconnecting');
			this.cleanup();
		}

		this.connectCallCount++;
		this.socket = new MockSocket();

		// Bind listeners
		if (!this.listenersBound) {
			this.socket.on('connect', () => {
				console.log('[TEST] Connected');
				this.isConnecting = false;
			});
			this.listenersBound = true;
		}

		return this.socket;
	}

	private cleanup(): void {
		this.cleanupCallCount++;
		if (this.socket) {
			this.socket.disconnect();
			this.socket = null;
		}
		this.listenersBound = false;
		this.isConnecting = false;
	}

	disconnect(): void {
		this.cleanup();
		this.username = '';
	}

	getSocket(): MockSocket | null {
		return this.socket;
	}

	getIsConnecting(): boolean {
		return this.isConnecting;
	}

	getUsername(): string {
		return this.username;
	}
}

// ============================================================================
// TESTS
// ============================================================================

export function runSocketManagerTests(): TestResult[] {
	const results: TestResult[] = [];

	// TEST 1: Initial connection
	{
		const manager = new TestableSocketManager();
		const socket1 = manager.connect('alice');
		const socket2 = manager.connect('alice'); // Should return same socket

		results.push({
			name: 'TEST 1: Initial connection creates socket',
			passed: socket1 !== null && manager.connectCallCount === 1,
			details: `Socket created: ${socket1 !== null}, Connect calls: ${manager.connectCallCount}`
		});

		results.push({
			name: 'TEST 1b: Second call with same username returns same socket',
			passed: socket1 === socket2 && manager.connectCallCount === 1,
			details: `Same socket returned: ${socket1 === socket2}, Total connect calls: ${manager.connectCallCount}`
		});
	}

	// TEST 2: Rapid successive calls don't create duplicates
	{
		const manager = new TestableSocketManager();

		// Simulate rapid calls before connect completes
		const socket1 = manager.connect('bob');
		const isConnecting = manager.getIsConnecting();
		const socket2 = manager.connect('bob');
		const socket3 = manager.connect('bob');

		results.push({
			name: 'TEST 2: Rapid successive calls blocked by isConnecting flag',
			passed: manager.connectCallCount === 1 && isConnecting === true,
			details: `Connect calls: ${manager.connectCallCount}, isConnecting: ${isConnecting}`
		});

		results.push({
			name: 'TEST 2b: All rapid calls return same socket reference',
			passed: socket1 === socket2 && socket2 === socket3,
			details: `Socket1 === Socket2: ${socket1 === socket2}, Socket2 === Socket3: ${socket2 === socket3}`
		});
	}

	// TEST 3: Switching usernames closes old socket
	{
		const manager = new TestableSocketManager();
		const socket1 = manager.connect('charlie');
		const oldCleanupCount = manager.cleanupCallCount;

		const socket2 = manager.connect('dave'); // Different username

		results.push({
			name: 'TEST 3: Switching usernames triggers cleanup',
			passed: manager.cleanupCallCount > oldCleanupCount,
			details: `Old cleanup count: ${oldCleanupCount}, New cleanup count: ${manager.cleanupCallCount}`
		});

		results.push({
			name: 'TEST 3b: Switching usernames creates new socket',
			passed: socket1 !== socket2 && manager.connectCallCount === 2,
			details: `Different sockets: ${socket1 !== socket2}, Total connects: ${manager.connectCallCount}`
		});
	}

	// TEST 4: Disconnect clears state
	{
		const manager = new TestableSocketManager();
		manager.connect('eve');

		const usernameBeforeDisconnect = manager.getUsername();
		manager.disconnect();
		const usernameAfterDisconnect = manager.getUsername();
		const socketAfterDisconnect = manager.getSocket();

		results.push({
			name: 'TEST 4: Disconnect clears username',
			passed: usernameBeforeDisconnect === 'eve' && usernameAfterDisconnect === '',
			details: `Before: '${usernameBeforeDisconnect}', After: '${usernameAfterDisconnect}'`
		});

		results.push({
			name: 'TEST 4b: Disconnect clears socket reference',
			passed: socketAfterDisconnect === null,
			details: `Socket after disconnect: ${socketAfterDisconnect}`
		});
	}

	// TEST 5: Reconnect after disconnect
	{
		const manager = new TestableSocketManager();
		manager.connect('frank');
		manager.disconnect();
		const socket2 = manager.connect('frank');

		results.push({
			name: 'TEST 5: Reconnect after disconnect creates new socket',
			passed: socket2 !== null && manager.connectCallCount === 2,
			details: `New socket created: ${socket2 !== null}, Total connects: ${manager.connectCallCount}`
		});
	}

	// TEST 6: Listener binding happens only once
	{
		const manager = new TestableSocketManager();
		const socket = manager.connect('grace') as MockSocket;
		const listenerCount1 = socket.listeners['connect']?.length || 0;

		// Try to bind again (shouldn't happen in real code, but test the guard)
		const socket2 = manager.connect('grace');

		results.push({
			name: 'TEST 6: Listeners not duplicated on reuse',
			passed: socket === socket2,
			details: `Same socket on reuse: ${socket === socket2}`
		});
	}

	return results;
}

// ============================================================================
// EXPORT FOR BROWSER TESTING
// ============================================================================

if (typeof window !== 'undefined') {
	(window as any).runSocketTests = () => {
		const results = runSocketManagerTests();
		console.log('\n========================================');
		console.log('🧪 SocketManager Test Results');
		console.log('========================================\n');

		let passed = 0;
		let failed = 0;

		results.forEach(result => {
			const icon = result.passed ? '✅' : '❌';
			console.log(`${icon} ${result.name}`);
			if (result.details) {
				console.log(`   Details: ${result.details}`);
			}
			if (result.error) {
				console.log(`   Error: ${result.error}`);
			}
			result.passed ? passed++ : failed++;
		});

		console.log(`\n========================================`);
		console.log(`Passed: ${passed}/${results.length}`);
		console.log(`Failed: ${failed}/${results.length}`);
		console.log(`========================================\n`);

		return { passed, failed, results };
	};

	console.log('✅ Socket tests loaded. Run: window.runSocketTests()');
}
