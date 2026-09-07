/** Socket.IO room authorization is a separate milestone from /ws or REST.
 * Install receive handlers before calling this: the server replays Opus
 * headers before acknowledging the join. Never start an encoder before ack.
 */
export function joinRelayRoom(
	socket: any, sessionId: string, channelId: string, signal?: AbortSignal, timeoutMs = 10000
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!socket.connected) { reject(new Error('Relay socket disconnected')); return; }
		if (signal?.aborted) { reject(new Error('Relay join cancelled')); return; }
		const requestId = crypto.randomUUID();
		const cleanup = () => {
			clearTimeout(timer);
			socket.off('wabidb-call-joined', joined);
			socket.off('wabidb-call-denied', denied);
			socket.off('disconnect', disconnected);
			signal?.removeEventListener('abort', aborted);
		};
		const fail = (message: string) => { cleanup(); reject(new Error(message)); };
		const matches = (data: any) => data?.sessionId === sessionId && data?.requestId === requestId;
		const joined = (data: any) => { if (matches(data)) { cleanup(); resolve(); } };
		const denied = (data: any) => { if (matches(data)) fail(`Relay join denied: ${data.reason ?? 'unauthorized'}`); };
		const disconnected = () => fail('Relay socket disconnected during join');
		const aborted = () => fail('Relay join cancelled');
		const timer = setTimeout(() => fail('Relay room authorization timed out'), timeoutMs);
		socket.on('wabidb-call-joined', joined);
		socket.on('wabidb-call-denied', denied);
		socket.on('disconnect', disconnected);
		signal?.addEventListener('abort', aborted, { once: true });
		try { socket.emit('join-wabidb-call', { sessionId, channelId, requestId }); }
		catch (error) { cleanup(); reject(error); }
	});
}
