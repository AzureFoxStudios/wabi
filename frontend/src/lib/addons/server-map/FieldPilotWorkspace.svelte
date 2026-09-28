<script lang="ts">
	import { onMount } from 'svelte';
	import { currentUser, serverMembers } from '$lib/socket';
	import { activeServerUrl } from '$lib/serverUrl';
	import {
		FieldApiError,
		acknowledgeFieldCheckin,
		consentToFieldSession,
		createFieldSession,
		endFieldSession,
		getFieldSession,
		leaveFieldSession,
		listFieldSessions,
		revokeFieldParticipant,
		sendFieldCheckin,
		type FieldCheckinReceipt,
		type FieldInvitation,
		type FieldParticipant,
		type FieldSession
	} from '$lib/api/field';
	import { fieldAge, hasPartialManualPin, markerPosition, openHelp, parseManualPin } from './fieldPilotHelpers';

	const POLL_MS = 5_000;
	let sessions: FieldSession[] = $state([]);
	let invitations: FieldInvitation[] = $state([]);
	let selectedId: string | null = $state(null);
	let session: FieldSession | null = $state(null);
	let loaded = $state(false);
	let busy = $state(false);
	let loadError = $state('');
	let actionError = $state('');
	let notice = $state('');
	let now = $state(Date.now());
	let title = $state('');
	let durationMinutes = $state(60);
	let invitedIds: number[] = $state([]);
	let xPercent = $state('');
	let yPercent = $state('');
	let lastReceipt: FieldCheckinReceipt | null = $state(null);
	let confirmEnd = $state(false);
	let confirmRemoveId: number | null = $state(null);

	let mounted = false;
	let epoch = 0;
	let ownerScope = '';
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let ageTimer: ReturnType<typeof setInterval> | null = null;
	let pollAbort: AbortController | null = null;
	let mutationAbort: AbortController | null = null;
	let retryNonce: string | null = null;
	let retryIntent = '';

	const myId = $derived(typeof $currentUser?.dbUserId === 'number' ? $currentUser.dbUserId : null);
	const canCreate = $derived($currentUser?.highestRole === 'owner' || $currentUser?.highestRole === 'admin');
	const directory = $derived(
		$serverMembers
			.filter((person) => typeof person.dbUserId === 'number' && person.dbUserId !== myId && !person.isBot && person.isRegistered !== false)
			.sort((a, b) => (a.handle || a.username).localeCompare(b.handle || b.username))
	);
	const ownParticipant = $derived(session?.participants.find((person) => person.userId === myId) || null);
	const participants = $derived(
		[...(session?.participants || [])].sort((a, b) => {
			const urgent = Number(openHelp(b) !== null) - Number(openHelp(a) !== null);
			return urgent || a.userId - b.userId;
		})
	);
	const positioned = $derived(participants.filter((person) => markerPosition(person) !== null));
	const mapImage = $derived(
		session?.mapImageUrl && /^\/uploads\/[a-zA-Z0-9._/-]+$/.test(session.mapImageUrl)
			? `${$activeServerUrl}${session.mapImageUrl}`
			: null
	);

	function personLabel(userId: number): string {
		if (userId === myId) return 'You';
		const person = $serverMembers.find((item) => item.dbUserId === userId);
		return person?.handle || person?.username || `Member #${userId}`;
	}

	function timestamp(value: number): string {
		return Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString() : 'Unknown time';
	}

	function statusText(person: FieldParticipant): string {
		if (!person.consented) return 'Awaiting consent';
		if (openHelp(person)) return 'Needs help';
		if (!person.lastCheckin) return 'No check-in yet';
		return person.lastCheckin.status === 'help' ? 'Needs help' : "I'm okay";
	}

	function isAbort(error: unknown): boolean {
		return error instanceof Error && error.name === 'AbortError';
	}

	function errorText(error: unknown): string {
		return error instanceof Error ? error.message : 'The request failed. Try again.';
	}

	function stopPolling(): void {
		epoch += 1;
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = null;
		pollAbort?.abort();
		pollAbort = null;
	}

	function retireExpiredSession(): void {
		if (sessions.some((item) => item.expiresAt <= Date.now())) sessions = sessions.filter((item) => item.expiresAt > Date.now());
		if (invitations.some((item) => item.expiresAt <= Date.now())) invitations = invitations.filter((item) => item.expiresAt > Date.now());
		if (!session || session.expiresAt > Date.now()) return;
		selectedId = null;
		session = null;
		lastReceipt = null;
		xPercent = '';
		yPercent = '';
		retryIntent = '';
		retryNonce = null;
		notice = 'This field session expired. Its live roster and pins are no longer available.';
		if (mounted && !busy) startPolling();
	}

	function updateClock(): void {
		now = Date.now();
		retireExpiredSession();
	}

	async function pollOnce(runEpoch: number): Promise<void> {
		const controller = new AbortController();
		pollAbort = controller;
		try {
			const result = await listFieldSessions(controller.signal);
			if (!mounted || epoch !== runEpoch) return;
			sessions = result.sessions;
			invitations = result.invitations;
			loaded = true;
			updateClock();
			const id = selectedId;
			if (id) {
				if (!result.sessions.some((item) => item.id === id)) {
					selectedId = null;
					session = null;
					lastReceipt = null;
					notice = 'This session ended or is no longer available to your account.';
				} else {
					try {
						const detail = await getFieldSession(id, controller.signal);
						if (!mounted || epoch !== runEpoch || selectedId !== id) return;
						session = detail.session;
					} catch (error) {
						if (error instanceof FieldApiError && (error.status === 403 || error.status === 404)) {
							selectedId = null;
							session = null;
							lastReceipt = null;
							notice = 'This session ended or is no longer available to your account.';
						} else throw error;
					}
				}
			}
			loadError = '';
		} catch (error) {
			if (mounted && epoch === runEpoch && !isAbort(error)) {
				loaded = true;
				loadError = `${errorText(error)} Last displayed reports may be old.`;
			}
		} finally {
			if (pollAbort === controller) pollAbort = null;
			if (mounted && epoch === runEpoch && !busy) pollTimer = setTimeout(() => void pollOnce(runEpoch), POLL_MS);
		}
	}

	function startPolling(): void {
		stopPolling();
		if (mounted && !busy) void pollOnce(epoch);
	}

	function resetForScope(scope: string): void {
		ownerScope = scope;
		stopPolling();
		mutationAbort?.abort();
		mutationAbort = null;
		busy = false;
		sessions = [];
		invitations = [];
		selectedId = null;
		session = null;
		loaded = false;
		loadError = '';
		actionError = '';
		notice = '';
		lastReceipt = null;
		xPercent = '';
		yPercent = '';
		retryNonce = null;
		retryIntent = '';
		startPolling();
	}

	$effect(() => {
		const scope = `${$activeServerUrl}|${myId ?? 'signed-out'}`;
		if (mounted && scope !== ownerScope) resetForScope(scope);
	});

	onMount(() => {
		mounted = true;
		ownerScope = `${$activeServerUrl}|${myId ?? 'signed-out'}`;
		startPolling();
		ageTimer = setInterval(updateClock, 30_000);
		document.addEventListener('visibilitychange', updateClock);
		window.addEventListener('focus', updateClock);
		return () => {
			mounted = false;
			stopPolling();
			mutationAbort?.abort();
			if (ageTimer) clearInterval(ageTimer);
			document.removeEventListener('visibilitychange', updateClock);
			window.removeEventListener('focus', updateClock);
		};
	});

	function selectSession(id: string | null): void {
		if (busy) return;
		selectedId = id;
		session = null;
		lastReceipt = null;
		actionError = '';
		notice = '';
		xPercent = '';
		yPercent = '';
		confirmEnd = false;
		confirmRemoveId = null;
		retryNonce = null;
		retryIntent = '';
		startPolling();
	}

	async function perform<T>(
		request: (signal: AbortSignal) => Promise<T>,
		apply: (result: T) => void
	): Promise<void> {
		if (busy || !mounted) return;
		stopPolling();
		const runEpoch = epoch;
		const controller = new AbortController();
		mutationAbort = controller;
		busy = true;
		actionError = '';
		try {
			const result = await request(controller.signal);
			if (mounted && epoch === runEpoch) apply(result);
		} catch (error) {
			if (!mounted || epoch !== runEpoch || isAbort(error)) return;
			if (error instanceof FieldApiError && (error.status === 403 || error.status === 404)) {
				selectedId = null;
				session = null;
				lastReceipt = null;
				notice = 'This session ended or is no longer available to your account.';
			} else {
				actionError = errorText(error);
			}
		} finally {
			if (mutationAbort === controller) mutationAbort = null;
			if (mounted && epoch === runEpoch) {
				busy = false;
				startPolling();
			}
		}
	}

	function toggleInvite(userId: number): void {
		invitedIds = invitedIds.includes(userId)
			? invitedIds.filter((id) => id !== userId)
			: [...invitedIds, userId];
	}

	function createSession(): void {
		if (!canCreate) { actionError = 'Only a server admin or owner can start this pilot.'; return; }
		const cleanTitle = title.trim();
		if (!cleanTitle) { actionError = 'Give this trial a name.'; return; }
		if (invitedIds.length === 0) { actionError = 'Select at least one adult or test account to invite.'; return; }
		void perform(
			(signal) => createFieldSession({ title: cleanTitle, participantIds: invitedIds, durationMinutes }, signal),
			(result) => {
				session = result.session;
				selectedId = result.session.id;
				loaded = true;
				title = '';
				invitedIds = [];
				notice = 'Session created. Invited accounts must consent before they can see the roster or positions.';
			}
		);
	}

	function consent(id: string): void {
		void perform((signal) => consentToFieldSession(id, signal), (result) => {
			selectedId = result.session.id;
			session = result.session;
			notice = 'You joined. All consenting session members can see the check-ins and manual pins you choose to send.';
		});
	}

	function chooseMapPoint(event: MouseEvent): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLElement)) return;
		const bounds = target.getBoundingClientRect();
		if (bounds.width <= 0 || bounds.height <= 0) return;
		xPercent = (Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * 100).toFixed(1);
		yPercent = (Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) * 100).toFixed(1);
	}

	function nonce(): string {
		const bytes = new Uint8Array(16);
		if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
		else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
		return Array.from(bytes, (part) => part.toString(16).padStart(2, '0')).join('');
	}

	function checkin(status: 'okay' | 'help'): void {
		if (!session || !ownParticipant?.consented) return;
		if (session.expiresAt <= Date.now()) { retireExpiredSession(); return; }
		if (hasPartialManualPin(xPercent, yPercent)) {
			actionError = 'Set both X and Y, or clear both for a status-only check-in.';
			return;
		}
		const point = parseManualPin(xPercent, yPercent);
		if ((xPercent.trim() || yPercent.trim()) && !point) {
			actionError = 'X and Y must each be between 0 and 100.';
			return;
		}
		const id = session.id;
		const intent = `${id}:${status}:${point?.x ?? 'none'}:${point?.y ?? 'none'}`;
		if (retryIntent !== intent || !retryNonce) {
			retryIntent = intent;
			retryNonce = nonce();
		}
		const input = { nonce: retryNonce, status, ...(point || {}) };
		void perform((signal) => sendFieldCheckin(id, input, signal), (result) => {
			session = result.session;
			lastReceipt = result.receipt;
			now = Date.now();
			notice = result.receipt.duplicate
				? 'The Authority already received this check-in. No duplicate report was added.'
				: 'The Authority received your check-in. A leader acknowledgement is separate.';
			retryIntent = '';
			retryNonce = null;
		});
	}

	function acknowledge(checkinId: string): void {
		if (!session?.isLeader) return;
		const id = session.id;
		void perform((signal) => acknowledgeFieldCheckin(id, checkinId, signal), (result) => {
			session = result.session;
			notice = 'Leader acknowledgement recorded.';
		});
	}

	function leave(): void {
		if (!session || session.isLeader) return;
		const id = session.id;
		void perform((signal) => leaveFieldSession(id, signal), () => {
			selectedId = null;
			session = null;
			lastReceipt = null;
			notice = 'You left the session. Your reports are no longer available through its active view.';
		});
	}

	function end(): void {
		if (!session?.isLeader) return;
		const id = session.id;
		void perform((signal) => endFieldSession(id, signal), () => {
			selectedId = null;
			session = null;
			lastReceipt = null;
			confirmEnd = false;
			notice = 'The session has ended for everyone.';
		});
	}

	function remove(userId: number): void {
		if (!session?.isLeader || userId === session.leaderUserId) return;
		const id = session.id;
		void perform((signal) => revokeFieldParticipant(id, userId, signal), (result) => {
			session = result.session;
			confirmRemoveId = null;
			notice = `${personLabel(userId)} no longer has session access.`;
		});
	}
</script>

<section class="field-pilot" aria-label="Field pilot">
	<header class="field-header">
		<div>
			<p class="eyebrow">LOCAL FIELD PILOT</p>
			<h2>Check in together</h2>
			<p class="field-intro">A short-lived session on this Wabi Authority. People send deliberate status updates and optional manual map pins. Use adult volunteers or test accounts for the first trial.</p>
		</div>
		<button type="button" class="minor" onclick={() => startPolling()} disabled={busy}>Refresh</button>
	</header>

	{#if loadError}
		<p class="banner error" role="alert">{loadError}</p>
	{/if}
	{#if actionError}
		<p class="banner error" role="alert">{actionError}</p>
	{/if}
	{#if notice}
		<p class="banner notice" role="status">{notice}</p>
	{/if}

	{#if selectedId && session && session.expiresAt > now}
		<div class="session-heading">
			<button type="button" class="minor" onclick={() => selectSession(null)} disabled={busy}>← Sessions</button>
			<div>
				<h3>{session.title}</h3>
				<p>Leader: {personLabel(session.leaderUserId)} · Ends {timestamp(session.expiresAt)}</p>
			</div>
		</div>
		<p class="boundary">Pins show the last <strong>manual</strong> position reported. They do not track devices or prove who is nearby. Check-in time and position time are shown separately.</p>
		<div class="field-grid">
			<section class="map-card" aria-label="Manual field schematic">
				<div class="schematic">
					{#if mapImage}<img src={mapImage} alt="" class="map-art" />{/if}
					<div class="grid-overlay"></div>
					<button type="button" class="map-hit" aria-label="Choose a manual position on the schematic" title="Tap to set your manual position" onclick={chooseMapPoint} disabled={busy || !ownParticipant?.consented}></button>
					{#each positioned as person (person.userId)}
						{@const point = markerPosition(person)}
						{#if point}
							<span class:help={openHelp(person) !== null} class="person-marker" style={`left:${point.x * 100}%;top:${point.y * 100}%`} title={`${personLabel(person.userId)}: manual position received ${fieldAge(person.lastPosition?.receivedAt, now)}`} aria-hidden="true">{personLabel(person.userId).slice(0, 1).toUpperCase()}</span>
						{/if}
					{/each}
					{#if parseManualPin(xPercent, yPercent)}
						{@const draft = parseManualPin(xPercent, yPercent)}
						{#if draft}<span class="draft-marker" style={`left:${draft.x * 100}%;top:${draft.y * 100}%`} aria-hidden="true">+</span>{/if}
					{/if}
					{#if positioned.length === 0 && !parseManualPin(xPercent, yPercent)}<span class="map-empty">No manual positions reported yet</span>{/if}
				</div>
				<p class="map-caption">Offline schematic · X increases right · Y increases down</p>
				{#if ownParticipant?.consented}
					<div class="pin-form">
						<label>X % <input type="number" min="0" max="100" step="0.1" inputmode="decimal" bind:value={xPercent} disabled={busy} /></label>
						<label>Y % <input type="number" min="0" max="100" step="0.1" inputmode="decimal" bind:value={yPercent} disabled={busy} /></label>
						<button type="button" class="minor" onclick={() => { xPercent = ''; yPercent = ''; }} disabled={busy}>Clear pin</button>
					</div>
						<p class="hint">Tap the schematic or enter coordinates. The pin is shared only when you send a check-in. Leave both fields empty to send status only.</p>
						{#if parseManualPin(xPercent, yPercent)}<p class="pin-preview">Ready to share a manual pin at X {xPercent}%, Y {yPercent}% with all consenting members when you send a check-in.</p>
						{:else if !xPercent.trim() && !yPercent.trim()}<p class="pin-preview">Next check-in will share status only; your last position, if any, will keep its original timestamp.</p>{/if}
					<div class="checkin-actions">
						<button type="button" class="okay-button" onclick={() => checkin('okay')} disabled={busy}>I'm okay</button>
						<button type="button" class="help-button" onclick={() => checkin('help')} disabled={busy}>Need help</button>
					</div>
					{#if lastReceipt}<p class="receipt">Authority received {timestamp(lastReceipt.receivedAt)} · Report {lastReceipt.checkinId.slice(0, 8)}{lastReceipt.duplicate ? ' · duplicate retry' : ''}. Leader acknowledgement appears below when recorded.</p>{/if}
				{:else}
					<p class="hint">Your account is not admitted to this session.</p>
				{/if}
			</section>

			<section class="roster-card" aria-label="Session participants">
				<h4>Last reports</h4>
				{#if participants.length === 0}<p class="hint">No participants are visible.</p>{/if}
				{#each participants as person (person.userId)}
					<article class:urgent={openHelp(person) !== null} class="participant">
						<div class="participant-top"><strong>{personLabel(person.userId)}</strong><span class:help-status={openHelp(person) !== null}>{statusText(person)}</span></div>
						{#if person.lastCheckin}
							<p>Latest contact: {person.lastCheckin.status === 'help' ? 'help' : 'okay'} · received by Authority {fieldAge(person.lastCheckin.receivedAt, now)} · {timestamp(person.lastCheckin.receivedAt)}</p>
						{:else if person.consented}<p>No check-in received yet.</p>{/if}
						{#if openHelp(person)}
							{@const help = openHelp(person)}
							{#if help}<p class="awaiting">Help request received {fieldAge(help.receivedAt, now)} · awaiting leader acknowledgement.</p>{/if}
						{/if}
						{#if person.lastHelpAcknowledgement}<p class="acknowledged">Help report {person.lastHelpAcknowledgement.id.slice(0, 8)} acknowledged by {personLabel(person.lastHelpAcknowledgement.acknowledgedByUserId)} {fieldAge(person.lastHelpAcknowledgement.acknowledgedAt, now)}.</p>{/if}
						{#if person.lastPosition}
							<p>Position last reported {fieldAge(person.lastPosition.receivedAt, now)} · manual · X {(person.lastPosition.x * 100).toFixed(1)}%, Y {(person.lastPosition.y * 100).toFixed(1)}%</p>
						{:else}<p>No position reported.</p>{/if}
						{#if session.isLeader && openHelp(person)}<button type="button" class="minor" onclick={() => acknowledge(openHelp(person)!.id)} disabled={busy}>Acknowledge help</button>{/if}
						{#if session.isLeader && person.userId !== session.leaderUserId}
							{#if confirmRemoveId === person.userId}
								<div class="confirm-row"><span>Remove access?</span><button type="button" onclick={() => remove(person.userId)} disabled={busy}>Confirm remove</button><button type="button" class="minor" onclick={() => (confirmRemoveId = null)}>Cancel</button></div>
							{:else}<button type="button" class="text-button" onclick={() => (confirmRemoveId = person.userId)} disabled={busy}>Remove participant</button>{/if}
						{/if}
					</article>
				{/each}
				<p class="hint">Silence can mean a missed report or lost connection. It does not establish distance or safety.</p>
			</section>
		</div>
		<div class="session-footer">
			{#if session.isLeader}
				{#if confirmEnd}<span>End access for everyone?</span><button type="button" class="danger" onclick={end} disabled={busy}>Confirm end</button><button type="button" class="minor" onclick={() => (confirmEnd = false)}>Cancel</button>
				{:else}<button type="button" class="minor" onclick={() => (confirmEnd = true)} disabled={busy}>End session</button>{/if}
			{:else}<button type="button" class="minor" onclick={leave} disabled={busy}>Leave session</button>{/if}
		</div>
	{:else if selectedId}
		<div class="empty"><p>Loading session…</p><button type="button" class="minor" onclick={() => selectSession(null)}>Back to sessions</button></div>
	{:else}
		<div class="landing-grid" class:single={!canCreate}>
			<section class="list-card">
				<h3>Your sessions</h3>
				{#if !loaded}<p class="hint">Loading sessions…</p>
				{:else if sessions.length === 0}<p class="hint">No active field sessions yet.</p>{/if}
				{#each sessions as item (item.id)}
					<button type="button" class="session-row" onclick={() => selectSession(item.id)} disabled={busy}><strong>{item.title}</strong><span>Ends {timestamp(item.expiresAt)} · {item.participants.length} people</span></button>
				{/each}
				<h3>Invitations</h3>
				{#if loaded && invitations.length === 0}<p class="hint">No invitations awaiting your consent.</p>{/if}
				{#each invitations as invite (invite.id)}
						<div class="invitation"><strong>{invite.title}</strong><p>From {personLabel(invite.leaderUserId)} · Ends {timestamp(invite.expiresAt)}</p><p>All consenting session members can see each other's deliberate check-ins and last manual pins. A pin is shared only when you send it with a check-in.</p><button type="button" onclick={() => consent(invite.id)} disabled={busy}>Join with consent</button></div>
				{/each}
			</section>
			{#if canCreate}<section class="create-card">
				<h3>Start a local trial</h3>
					<p class="hint">Server admins and owners can start a pilot. Select adult volunteers or test accounts already joined to this Wabi server. The map starts as an offline schematic.</p>
				<label class="form-field">Session name<input type="text" maxlength="80" bind:value={title} placeholder="Park walk test" disabled={busy} /></label>
				<label class="form-field">Expires after<select bind:value={durationMinutes} disabled={busy}><option value={30}>30 minutes</option><option value={60}>1 hour</option><option value={120}>2 hours</option></select></label>
				<fieldset disabled={busy}><legend>Invite people</legend>
					{#if directory.length === 0}<p class="hint">No registered members are available to invite. Join the other devices to this server first.</p>{/if}
					{#each directory as person (person.dbUserId)}
						<label class="invite-person"><input type="checkbox" checked={invitedIds.includes(person.dbUserId!)} onchange={() => toggleInvite(person.dbUserId!)} /><span>{person.handle || person.username}</span></label>
					{/each}
				</fieldset>
				<button type="button" onclick={createSession} disabled={busy || !myId}>Create session</button>
			</section>{/if}
		</div>
	{/if}
</section>

<style>
	.field-pilot { height:100%; min-height:0; overflow:auto; padding:1rem; color:var(--text-primary, #e8e8f4); }
	.field-header { display:flex; justify-content:space-between; align-items:start; gap:1rem; margin-bottom:1rem; }
	.field-header h2 { margin:.1rem 0 .35rem; font-size:1.45rem; }
	.eyebrow { margin:0; color:var(--accent-primary, #a89cff); font-size:.7rem; font-weight:750; letter-spacing:.11em; }
	.field-intro { max-width:70ch; margin:0; color:var(--text-secondary, #b7b7c8); line-height:1.4; }
	button, input, select { font:inherit; }
	button { cursor:pointer; border:1px solid var(--color-border-primary, #464158); border-radius:.55rem; padding:.5rem .75rem; background:var(--accent-primary, #7869c6); color:#fff; }
	button:disabled { opacity:.5; cursor:not-allowed; }
	button:focus-visible, input:focus-visible, select:focus-visible { outline:2px solid var(--accent-primary, #a89cff); outline-offset:2px; }
	button.minor { background:var(--surface-raised, #302d3f); color:inherit; }
	button.text-button { padding:.2rem 0; border:0; background:none; color:var(--text-secondary, #b7b7c8); text-decoration:underline; }
	button.danger, button.help-button { background:#a33145; border-color:#b8475b; }
	button.okay-button { background:#26735c; border-color:#329171; }
	.banner { border-radius:.5rem; padding:.65rem .8rem; margin:.5rem 0; }
	.banner.error { background:#5c2633; border:1px solid #ad566b; }
	.banner.notice { background:#254d43; border:1px solid #347c67; }
	.boundary { padding:.65rem .8rem; border-left:3px solid var(--accent-primary, #8b7ed3); background:var(--surface-raised, #282536); color:var(--text-secondary, #c4c4d0); }
	.session-heading { display:flex; align-items:center; gap:1rem; flex-wrap:wrap; }
	.session-heading h3 { margin:0; font-size:1.3rem; }
	.session-heading p { margin:.15rem 0; color:var(--text-secondary, #b7b7c8); }
	.field-grid { display:grid; grid-template-columns:minmax(0,1.3fr) minmax(260px,1fr); gap:1rem; align-items:start; }
	.map-card, .roster-card, .list-card, .create-card { min-width:0; padding:1rem; border:1px solid var(--color-border-primary, #464158); border-radius:.75rem; background:var(--surface-raised, #252234); }
	.schematic { position:relative; width:100%; aspect-ratio:1.4; min-height:230px; overflow:hidden; border:1px solid var(--color-border-primary, #464158); border-radius:.55rem; background:#263b42; }
	.map-art { position:absolute; inset:0; width:100%; height:100%; object-fit:fill; }
	.grid-overlay { position:absolute; inset:0; background-image:linear-gradient(to right, #ffffff23 1px, transparent 1px), linear-gradient(to bottom, #ffffff23 1px, transparent 1px); background-size:10% 10%; }
	.map-hit { position:absolute; z-index:1; inset:0; width:100%; height:100%; padding:0; border:0; background:transparent; border-radius:0; }
	.map-hit:focus-visible { outline:3px solid #fff; outline-offset:-4px; }
	.person-marker, .draft-marker { position:absolute; z-index:2; transform:translate(-50%, -50%); display:grid; place-items:center; width:1.8rem; height:1.8rem; border-radius:50%; border:2px solid #fff; background:#16674f; color:white; font-weight:700; pointer-events:none; box-shadow:0 2px 8px #0008; }
	.person-marker.help { background:#b92f45; }
	.draft-marker { width:1.4rem; height:1.4rem; border-style:dashed; background:#6252c0; }
	.map-empty { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); pointer-events:none; padding:.4rem .65rem; border-radius:.4rem; background:#111a22ba; text-align:center; }
	.map-caption, .hint { color:var(--text-secondary, #b7b7c8); font-size:.85rem; line-height:1.45; }
	.pin-form { display:flex; align-items:end; gap:.5rem; flex-wrap:wrap; }
	.pin-form label { display:flex; flex-direction:column; gap:.25rem; font-size:.85rem; }
	input, select { max-width:100%; border:1px solid var(--color-border-primary, #504b63); border-radius:.4rem; background:var(--surface-base, #1a1825); color:inherit; padding:.45rem .5rem; }
	.pin-form input { width:6.5rem; }
	.checkin-actions { display:flex; gap:.6rem; flex-wrap:wrap; margin-top:.7rem; }
	.checkin-actions button { min-width:7.5rem; font-weight:700; }
	.receipt { margin:.7rem 0 0; padding:.55rem; background:#1e453a; border-radius:.4rem; font-size:.85rem; }
	.pin-preview { margin:.55rem 0; padding:.55rem; background:var(--surface-base, #1b1927); border:1px solid var(--color-border-primary, #504b63); border-radius:.4rem; font-size:.85rem; }
	.roster-card h4 { margin:0 0 .65rem; }
	.participant { padding:.7rem 0; border-top:1px solid var(--color-border-primary, #464158); }
	.participant.urgent { border-left:3px solid #da6175; padding-left:.6rem; }
	.participant-top { display:flex; justify-content:space-between; gap:.5rem; flex-wrap:wrap; }
	.participant-top span { color:#a6dbb6; }
	.participant-top span.help-status, .awaiting { color:#ff98a5; }
	.participant p { margin:.28rem 0; color:var(--text-secondary, #c2c2ce); font-size:.82rem; }
	.participant .acknowledged { color:#a6dbb6; }
	.confirm-row, .session-footer { display:flex; flex-wrap:wrap; align-items:center; gap:.5rem; margin-top:.75rem; }
	.landing-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(260px,1fr); gap:1rem; }
	.landing-grid.single { grid-template-columns:1fr; }
	.landing-grid h3 { margin:.1rem 0 .7rem; }
	.list-card h3:not(:first-child) { margin-top:1.3rem; }
	.session-row { display:flex; flex-direction:column; width:100%; text-align:left; gap:.2rem; margin:.45rem 0; background:var(--surface-base, #1b1927); color:inherit; }
	.session-row span { color:var(--text-secondary, #b7b7c8); font-size:.82rem; }
	.invitation { padding:.75rem; margin:.55rem 0; border:1px solid var(--color-border-primary, #504b63); border-radius:.55rem; }
	.invitation p { margin:.35rem 0; color:var(--text-secondary, #b7b7c8); font-size:.85rem; }
	.form-field { display:flex; flex-direction:column; gap:.3rem; margin:.8rem 0; }
	fieldset { margin:.8rem 0; border:1px solid var(--color-border-primary, #504b63); border-radius:.5rem; max-height:12rem; overflow:auto; }
	legend { padding:0 .3rem; }
	.invite-person { display:flex; align-items:center; gap:.5rem; margin:.35rem 0; }
	.empty { padding:1rem; }
	@media (max-width:800px) { .field-grid, .landing-grid { grid-template-columns:1fr; } .field-pilot { padding:.7rem; } .field-header { flex-wrap:wrap; } }
</style>
