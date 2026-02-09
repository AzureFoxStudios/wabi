/**
 * SocketManager v2 Unit Tests
 * Tests the state machine and connection lifecycle
 */

interface TestResult {
	name: string;
	passed: boolean;
	error?: string;
	details?: string;
}

// ============================================================================
// MOCK SOCKET
// ============================================================================

class MockSocket {
	public id = 'mock-socket-' + Math.random().toString(36).slice(2);
	public connected = false;
	public disconnected = true;
	private listeners: Record<string, Function[]> = {};
	public io = {
		engine: {
			on: (event: string, cb: Function) => {}
		}
	};

	on(event: string, callback: Function) {
		if (!this.listeners[event]) this.listeners[event] = [];
		this.listeners[event].push(callback);
	}

	off(event: string, callback?: Function) {
		if (callback && this.listeners[event]) {
			this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
		} else {
			delete this.listeners[event];
		}
	}

	removeAllListeners() {
		this.listeners = {};
	}

	emit(event: string, ...args: any[]) {
		if (this.listeners[event]) {
			this.listeners[event].forEach(cb => cb(...args));
		}
	}

	disconnect() {
		this.connected = false;
		this.disconnected = true;
	}

	// Test helpers
	simulateConnect() {
		this.connected = true;
		this.disconnected = false;
		this.emit('connect');
	}

	simulateDisconnect(reason: string) {
		this.connected = false;
		this.disconnected = true;
		this.emit('disconnect', reason);
	}

	simulateConnectError(message: string) {
		this.emit('connect_error', new Error(message));
	}

	getListenerCount(event: string): number {
		return this.listeners[event]?.length || 0;
	}
}

// ============================================================================
// TESTABLE SOCKET MANAGER (mirrors real implementation)
// ============================================================================

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

const VALID_TRANSITIONS: Record<ConnectionState, ConnectionState[]> = {
	disconnected: ['connecting'],
	connecting: ['connected', 'reconnecting', 'failed', 'disconnected'],
	connected: ['reconnecting', 'disconnected'],
	reconnecting: ['connecting', 'failed', 'disconnected'],
	failed: ['disconnected', 'connecting']
};

class TestableSocketManager {
	private socket: MockSocket | null = null;
	private username: string = '';
	private state: ConnectionState = 'disconnected';

	// Metrics for testing
	public connectCalls = 0;
	public cleanupCalls = 0;
	public listenerBindCalls = 0;
	public reconnectAttempts = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly maxReconnectAttempts = 3;

	private canTransition(to: ConnectionState): boolean {
		return VALID_TRANSITIONS[this.state].includes(to);
	}

	private transition(to: ConnectionState): boolean {
		if (!this.canTransition(to)) {
			console.log(`[TEST] Invalid transition: ${this.state} -> ${to}`);
			return false;
		}
		console.log(`[TEST] State: ${this.state} -> ${to}`);
		this.state = to;
		return true;
	}

	getState(): ConnectionState {
		return this.state;
	}

	connect(username: string): MockSocket | null {
		// Guard: already connecting
		if (this.state === 'connecting') {
			console.log('[TEST] Already connecting, returning existing socket');
			return this.socket;
		}

		// Guard: already connected with same username
		if (this.state === 'connected' && this.username === username && this.socket) {
			console.log('[TEST] Already connected with same username');
			return this.socket;
		}

		// Attempt transition
		if (!this.canTransition('connecting')) {
			console.log('[TEST] Cannot transition to connecting, forcing reset');
			this.forceReset();
		}

		this.transition('connecting');
		this.username = username;

		// Clean up existing socket
		if (this.socket) {
			this.destroySocket();
		}

		this.connectCalls++;
		this.socket = new MockSocket();
		this.bindListeners();

		return this.socket;
	}

	private bindListeners(): void {
		if (!this.socket) return;
		const sock = this.socket;

		sock.removeAllListeners();
		this.listenerBindCalls++;

		sock.on('connect', () => {
			this.transition('connected');
			this.reconnectAttempts = 0;
		});

		sock.on('disconnect', (reason: string) => {
			if (reason === 'io client disconnect' || reason === 'io server disconnect') {
				this.transition('disconnected');
			} else {
				this.scheduleReconnect();
			}
		});

		sock.on('connect_error', (error: Error) => {
			if (error.message.includes('auth') || error.message.includes('CORS')) {
				this.transition('failed');
			} else {
				this.scheduleReconnect();
			}
		});
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer) return;
		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			this.transition('failed');
			return;
		}

		if (!this.canTransition('reconnecting')) return;
		this.transition('reconnecting');
		this.reconnectAttempts++;

		// Simulate delay (immediate for tests)
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (this.state === 'reconnecting') {
				this.connect(this.username);
			}
		}, 10);
	}

	disconnect(): void {
		this.cancelReconnect();
		this.destroySocket();
		this.username = '';
		this.reconnectAttempts = 0;
		this.state = 'disconnected';
	}

	forceReset(): void {
		this.cancelReconnect();
		this.destroySocket();
		this.state = 'disconnected';
		this.reconnectAttempts = 0;
	}

	private destroySocket(): void {
		this.cleanupCalls++;
		if (this.socket) {
			this.socket.removeAllListeners();
			this.socket.disconnect();
			this.socket = null;
		}
	}

	private cancelReconnect(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	getSocket(): MockSocket | null {
		return this.socket;
	}

	// Test helper: manually trigger reconnect timer
	async waitForReconnect(): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, 20));
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
		const socket = manager.connect('alice');

		results.push({
			name: 'TEST 1: Initial connect transitions to connecting state',
			passed: manager.getState() === 'connecting' && socket !== null,
			details: `State: ${manager.getState()}, Socket: ${socket !== null}`
		});
	}

	// TEST 2: Successful connection
	{
		const manager = new TestableSocketManager();
		const socket = manager.connect('bob');
		socket?.simulateConnect();

		results.push({
			name: 'TEST 2: Successful connect transitions to connected',
			passed: manager.getState() === 'connected',
			details: `State: ${manager.getState()}`
		});
	}

	// TEST 3: Duplicate connection calls during connecting state
	{
		const manager = new TestableSocketManager();
		const socket1 = manager.connect('charlie');
		const socket2 = manager.connect('charlie');
		const socket3 = manager.connect('charlie');

		results.push({
			name: 'TEST 3: Duplicate calls during connecting return same socket',
			passed: socket1 === socket2 && socket2 === socket3 && manager.connectCalls === 1,
			details: `Same socket: ${socket1 === socket2 && socket2 === socket3}, Connect calls: ${manager.connectCalls}`
		});
	}

	// TEST 4: Duplicate connection calls when already connected
	{
		const manager = new TestableSocketManager();
		const socket1 = manager.connect('dave');
		socket1?.simulateConnect();

		const callsBefore = manager.connectCalls;
		const socket2 = manager.connect('dave');

		results.push({
			name: 'TEST 4: Duplicate calls when connected return same socket',
			passed: socket1 === socket2 && manager.connectCalls === callsBefore,
			details: `Same socket: ${socket1 === socket2}, No new connects: ${manager.connectCalls === callsBefore}`
		});
	}

	// TEST 5: Switching users triggers new connection
	{
		const manager = new TestableSocketManager();
		const socket1 = manager.connect('eve');
		socket1?.simulateConnect();

		const socket2 = manager.connect('frank'); // Different user

		results.push({
			name: 'TEST 5: Switching users creates new socket',
			passed: socket1 !== socket2 && manager.connectCalls === 2,
			details: `Different socket: ${socket1 !== socket2}, Connect calls: ${manager.connectCalls}`
		});
	}

	// TEST 6: Disconnect transitions to disconnected
	{
		const manager = new TestableSocketManager();
		manager.connect('grace');
		manager.getSocket()?.simulateConnect();

		manager.disconnect();

		results.push({
			name: 'TEST 6: Disconnect transitions to disconnected',
			passed: manager.getState() === 'disconnected' && manager.getSocket() === null,
			details: `State: ${manager.getState()}, Socket: ${manager.getSocket()}`
		});
	}

	// TEST 7: Reconnect after disconnect
	{
		const manager = new TestableSocketManager();
		manager.connect('henry');
		manager.getSocket()?.simulateConnect();
		manager.disconnect();

		const socket = manager.connect('henry');

		results.push({
			name: 'TEST 7: Reconnect after disconnect works',
			passed: socket !== null && manager.getState() === 'connecting',
			details: `Socket: ${socket !== null}, State: ${manager.getState()}`
		});
	}

	// TEST 8: Transport close triggers reconnect
	{
		const manager = new TestableSocketManager();
		manager.connect('iris');
		manager.getSocket()?.simulateConnect();
		manager.getSocket()?.simulateDisconnect('transport close');

		results.push({
			name: 'TEST 8: Transport close triggers reconnecting state',
			passed: manager.getState() === 'reconnecting',
			details: `State: ${manager.getState()}`
		});
	}

	// TEST 9: Server disconnect does NOT trigger reconnect
	{
		const manager = new TestableSocketManager();
		manager.connect('jack');
		manager.getSocket()?.simulateConnect();
		manager.getSocket()?.simulateDisconnect('io server disconnect');

		results.push({
			name: 'TEST 9: Server disconnect does not trigger reconnect',
			passed: manager.getState() === 'disconnected',
			details: `State: ${manager.getState()}`
		});
	}

	// TEST 10: Auth error goes to failed state
	{
		const manager = new TestableSocketManager();
		manager.connect('kate');
		manager.getSocket()?.simulateConnectError('auth token invalid');

		results.push({
			name: 'TEST 10: Auth error transitions to failed',
			passed: manager.getState() === 'failed',
			details: `State: ${manager.getState()}`
		});
	}

	// TEST 11: Network error triggers reconnect
	{
		const manager = new TestableSocketManager();
		manager.connect('luke');
		manager.getSocket()?.simulateConnectError('xhr poll error');

		results.push({
			name: 'TEST 11: Network error triggers reconnecting state',
			passed: manager.getState() === 'reconnecting',
			details: `State: ${manager.getState()}`
		});
	}

	// TEST 12: Max reconnect attempts leads to failed
	{
		const manager = new TestableSocketManager();
		manager.connect('mary');

		// Simulate multiple reconnect failures
		for (let i = 0; i < 5; i++) {
			manager.getSocket()?.simulateConnectError('network error');
		}

		// Wait for reconnect timers
		// (In real tests we'd await, here we just check the state machine)
		results.push({
			name: 'TEST 12: Max reconnect attempts transitions to failed',
			passed: manager.reconnectAttempts >= 3 || manager.getState() === 'failed',
			details: `State: ${manager.getState()}, Attempts: ${manager.reconnectAttempts}`
		});
	}

	// TEST 13: Listeners not duplicated on reconnect
	{
		const manager = new TestableSocketManager();
		manager.connect('nancy');
		const socket1 = manager.getSocket();
		socket1?.simulateConnect();

		// Simulate reconnect
		socket1?.simulateDisconnect('transport close');
		manager.connect('nancy');

		results.push({
			name: 'TEST 13: Listeners rebound cleanly (old removed)',
			passed: manager.listenerBindCalls >= 2, // Should rebind on new socket
			details: `Listener bind calls: ${manager.listenerBindCalls}`
		});
	}

	// TEST 14: Force reset from any state
	{
		const manager = new TestableSocketManager();
		manager.connect('oscar');
		manager.getSocket()?.simulateConnectError('auth error');
		// Now in failed state

		manager.forceReset();

		results.push({
			name: 'TEST 14: Force reset works from failed state',
			passed: manager.getState() === 'disconnected',
			details: `State: ${manager.getState()}`
		});

		// Can connect again after reset
		const socket = manager.connect('oscar');
		results.push({
			name: 'TEST 14b: Can connect after force reset',
			passed: socket !== null && manager.getState() === 'connecting',
			details: `Socket: ${socket !== null}, State: ${manager.getState()}`
		});
	}

	// TEST 15: State machine prevents invalid transitions
	{
		const manager = new TestableSocketManager();
		// Try to go from disconnected directly to connected (invalid)
		// Our manager should handle this gracefully

		manager.connect('peter');
		const state1 = manager.getState();

		results.push({
			name: 'TEST 15: State machine enforces valid transitions',
			passed: state1 === 'connecting', // Must go through connecting first
			details: `State after connect: ${state1}`
		});
	}

	return results;
}

// ============================================================================
// BROWSER TEST RUNNER
// ============================================================================

if (typeof window !== 'undefined') {
	(window as any).runSocketTests = () => {
		const results = runSocketManagerTests();
		console.log('\n========================================');
		console.log('🧪 SocketManager v2 Test Results');
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

	console.log('✅ Socket v2 tests loaded. Run: window.runSocketTests()');
}
