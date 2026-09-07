import type { LocalAudioCaptureSession } from './callingTypes';

type CommitCapture = (session: LocalAudioCaptureSession) => void;

/** The shared microphone has one owner across calls and transports. Capture
 * permission cannot be cancelled, but a superseded result must be disposed,
 * never published. Keep the current capture until its replacement commits.
 */
export class AudioCaptureOwner {
	current: LocalAudioCaptureSession | null = null;
	private pending: { promise: Promise<LocalAudioCaptureSession>; cancel: () => void } | null = null;

	constructor(
		private readonly create: () => Promise<LocalAudioCaptureSession>,
		private readonly dispose: (session: LocalAudioCaptureSession) => void
	) {}

	ensure(commit: CommitCapture): Promise<LocalAudioCaptureSession> {
		return this.pending?.promise ?? this.replace(commit);
	}

	replace(commit: CommitCapture): Promise<LocalAudioCaptureSession> {
		this.cancelPending();
		const aborted = () => new DOMException('Microphone capture superseded or call ended', 'AbortError');
		let cancel!: () => void;
		const cancelled = new Promise<never>((_, reject) => { cancel = () => reject(aborted()); });
		const request = { promise: Promise.resolve(null as unknown as LocalAudioCaptureSession), cancel };
		this.pending = request;
		const run = async () => {
			const session = await this.create();
			if (this.pending !== request) {
				this.dispose(session);
				throw aborted();
			}
			try { commit(session); }
			catch (error) { this.dispose(session); throw error; }
			const previous = this.current;
			this.current = session;
			if (previous) this.dispose(previous);
			return session;
		};
		request.promise = Promise.race([run(), cancelled]).finally(() => {
			if (this.pending === request) this.pending = null;
		});
		return request.promise;
	}

	clear(): void {
		this.cancelPending(); // even when permission hasn't produced a session yet
		const previous = this.current;
		this.current = null;
		if (previous) this.dispose(previous);
	}

	private cancelPending(): void {
		const pending = this.pending;
		this.pending = null;
		pending?.cancel();
	}
}
