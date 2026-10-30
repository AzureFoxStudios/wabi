<script lang="ts">
	/**
	 * Calls, the center-stage workspace (design contract §7.26, §8.5).
	 *
	 * - Row A of the masthead is described through `setStageHeader`: "Calls" + a micro summary
	 *   ("3 rooms · mic in Studio lounge"). The global controls live there and only while a call
	 *   is connected: Mic, Sound, Record (one control: "Recording 02:14" while it runs), "Leave
	 *   all", ⋯ (Connection details, camera). There is no footer button bar.
	 * - Body: "IN CALL" call cards that say where your mic goes ("Mic here" / "Muted",
	 *   "Listening", "Silent"), then "OTHER ROOMS" as hairline rows with Listen and Join. One list
	 *   of rooms: a room you are in is a card, never also a row.
	 * - Joining shows "Joining…" (aria-busy) on the pressed button; a failure leaves an inline
	 *   notice with Retry under that row. Recording and route changes report failures the same way.
	 * - Connection details (route, latency, packet loss; no privacy claim) are one section here,
	 *   opened from ⋯ or from the sidebar voice status row.
	 */
	import { onDestroy } from 'svelte';
	import { _ } from '$lib/i18n';
	import { callSessions } from '$lib/callSessionManager';
	import { callStateWord, callsSummary, sessionState, type CallCopy, type CallSession } from '$lib/callSessionTypes';
	import { joinFailureText, type CallJoinMode } from '$lib/callJoinState';
	import { voiceChannelMembers } from '$lib/presenceStore';
	import { channels } from '$lib/channelStore';
	import { users, serverMembers } from '$lib/socket';
	import { wabidbRemoteVideoSessions } from '$lib/wabidbVideoLane';
	import {
		joinVoice,
		dismissJoinFailure,
		callJoinAttempts,
		callConnectionDetailsOpen,
		leaveCall,
		focusCall,
		setCallVolume,
		toggleCallSpeaker,
		muteAllMic,
		unmuteAllMic,
		deafenAll,
		undeafenAll,
		cameraOff,
		leaveAllCalls
	} from '$lib/callSurfaces';
	import {
		isMuted,
		isDeafened,
		isVideoOff,
		activeCalls,
		speakingUsers,
		callTransportState,
		callConnectionDiagnostics,
		switchCallTransport,
		localScreenStream,
		screenShares
	} from '$lib/calling';
	import { callRecordingState, startCallRecording, stopCallRecording, formatRecordingElapsedForUi } from '$lib/callRecording';
	import { voiceCallRecordingParticipants } from '$lib/callRecordingPresence';
	import { getSocket } from '$lib/socketConnection';
	import { setStageHeader, clearStageHeader, type StageHeaderAction } from '$lib/stageHeader';
	import { isMobile } from '$lib/layoutStoreStates';
	import { inkFor } from '$lib/theme/identity';
	import { mediaUrl } from '$lib/mediaUrl';
	import VideoSink from './VideoSink.svelte';
	import Icon from './ui/Icon.svelte';
	import Notice from './ui/Notice.svelte';
	import Menu from './ui/Menu.svelte';
	import Segmented from './ui/Segmented.svelte';
	import type { MenuEntry } from './context-menu/ContextMenu.svelte';

	const uid = $props.id();
	const HEADER_OWNER = 'calls';
	/** Avatars drawn on a card before "+N" (row 2 keeps one line at the 320px card minimum). */
	const CARD_FACES = 5;
	/** Faces in an other-room row's 20px stack. */
	const ROW_FACES = 5;

	const t: CallCopy = (key, values) => $_(key, values ? { values } : undefined);

	// ---------- sessions and rooms ----------

	let sessions = $derived(
		[...$callSessions.values()].sort((a, b) => {
			if (a.focus === 'focused') return -1;
			if (b.focus === 'focused') return 1;
			return b.joinedAt - a.joinedAt;
		})
	);
	const inCall = $derived(sessions.length > 0);

	let voiceChannels = $derived(
		[...$channels].filter((ch) => ch.type === 'voice').sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id))
	);
	/** One list: a room you are in is a card above, never a second row here. */
	const otherRooms = $derived(voiceChannels.filter((ch) => !$callSessions.has(ch.id)));

	// Sessions register with `name: channelId` as a placeholder (channels load async): resolve the
	// real channel name at render time.
	function displayName(session: { id: string; name?: string | null; channelId?: string | null }): string {
		return (session.channelId ? $channels.find((c) => c.id === session.channelId)?.name : undefined) ?? session.name ?? session.id;
	}

	const summary = $derived(callsSummary(sessions, { nameOf: displayName, roomCount: voiceChannels.length, t }));

	// ---------- people ----------

	const memberColors = $derived.by(() => {
		const map = new Map<string, string>();
		for (const person of [...$serverMembers, ...$users]) {
			if (!person?.color) continue;
			if (person.id) map.set(person.id, person.color);
			if (person.dbUserId != null) map.set(`user-${person.dbUserId}`, person.color);
		}
		return map;
	});

	interface Face {
		userId: string;
		name: string;
		initial: string;
		picture: string | null;
		ink: string;
		speaking: boolean;
		muted: boolean;
		deafened: boolean;
		listenOnly: boolean;
	}

	function face(member: {
		userId: string;
		username?: string | null;
		profilePicture?: string | null;
		isSpeaking?: boolean;
		isMuted?: boolean;
		isDeafened?: boolean;
		isListenOnly?: boolean;
	}): Face {
		const name = member.username || member.userId;
		return {
			userId: member.userId,
			name,
			initial: (name.trim().charAt(0) || '?').toUpperCase(),
			picture: member.profilePicture ? mediaUrl(member.profilePicture) : null,
			ink: $inkFor(memberColors.get(member.userId)),
			speaking: Boolean(member.isSpeaking) || $speakingUsers.has(member.userId),
			muted: Boolean(member.isMuted),
			deafened: Boolean(member.isDeafened),
			listenOnly: Boolean(member.isListenOnly)
		};
	}

	function faceState(person: Face): string {
		if (person.speaking) return t('calls.speaking');
		if (person.deafened) return 'Deafened';
		if (person.muted) return t('calls.muted');
		if (person.listenOnly) return t('calls.listening');
		return '';
	}

	function sessionFaces(session: CallSession): Face[] {
		const roster = session.channelId ? ($voiceChannelMembers[session.channelId] ?? null) : null;
		if (roster && roster.length > 0) return roster.map((m) => face(m));
		if (session.kind !== 'channel' && session.participants.length === 0) {
			// DM/group sessions have no channel roster: fall back to the live call list (review F4).
			return $activeCalls.map((call) => face({ userId: call.userId, username: call.username ?? call.userId }));
		}
		return session.participants.map((p) => face(p));
	}

	function roomFaces(channelId: string): Face[] {
		return ($voiceChannelMembers[channelId] ?? []).map((m) => face(m));
	}

	/** Who is recording in a room: recording is a consent signal every participant sees (§9.5). */
	function recordersIn(session: CallSession, faces: Face[]): string[] {
		const recorders = session.channelId ? ($voiceCallRecordingParticipants[session.channelId] ?? []) : [];
		return recorders.map((r) => r.username || faces.find((f) => f.userId === r.userId)?.name || '').filter(Boolean);
	}

	// ---------- video tiles ----------

	/** Own screen preview: the wabidb lane self-filters our stream, so without an explicit local
	 * tile you can never confirm your own share is live. */
	const ownScreenStream = $derived(($localScreenStream?.getVideoTracks().length ?? 0) > 0 ? $localScreenStream : null);

	function sessionVideos(session: CallSession): Array<[string, MediaStream]> {
		const ids = new Set(session.participants.map((p) => p.userId));
		const entries = [...($wabidbRemoteVideoSessions.get(session.id) ?? new Map<string, MediaStream>()).entries()].filter(([key]) =>
			ids.has(key.replace(/:(camera|screen)$/, ''))
		);
		// P2P screenshares live in the screenShares store after a route change: fold them in by
		// owner. The wabidb entry wins on dedupe, so keys never collide.
		for (const share of $screenShares) {
			if ((share.channelId ?? null) !== session.channelId) continue;
			const owner = /^\d+$/.test(share.userId) ? `user-${share.userId}` : share.userId;
			if (!ids.has(owner)) continue;
			if (entries.some(([key]) => key === `${owner}:screen`)) continue;
			entries.push([`${owner}:screen`, share.stream]);
		}
		return entries;
	}

	function videoOwnerName(session: CallSession, key: string): string {
		const owner = key.replace(/:(camera|screen)$/, '');
		return session.participants.find((p) => p.userId === owner)?.username || owner;
	}

	// ---------- recording: one control, one readout ----------

	let recordBusy = $state(false);
	let recordFailure = $state<'start' | 'stop' | null>(null);
	let recordError = $state<unknown>(null);
	const recording = $derived($callRecordingState.status === 'recording');
	const savingRecording = $derived($callRecordingState.status === 'saving');
	const recordElapsed = $derived(recording ? formatRecordingElapsedForUi($callRecordingState.elapsedMs) : '');

	async function handleToggleRecord(): Promise<void> {
		if (recordBusy) return;
		recordBusy = true;
		const stopping = $callRecordingState.status === 'recording' || $callRecordingState.status === 'saving';
		try {
			recordFailure = null;
			if (stopping) await stopCallRecording();
			else await startCallRecording();
		} catch (err) {
			recordError = err;
			recordFailure = stopping ? 'stop' : 'start';
		} finally {
			recordBusy = false;
		}
	}

	// ---------- route (transport) ----------

	type Route = 'wabidb' | 'p2p';
	const currentTransport = $derived($callTransportState.activeTransport);
	let routeBusy = $state(false);
	let routeFailure = $state<'offline' | 'failed' | null>(null);
	let routeError = $state<unknown>(null);
	/** Re-keys the route control after an attempt so it always shows the route in use. */
	let routeAttempt = $state(0);

	const routeWord = $derived(
		currentTransport === 'wabidb' ? t('calls.route_server') : currentTransport === 'p2p' ? t('calls.route_direct') : 'Through a media server'
	);

	async function switchRoute(target: Route): Promise<void> {
		if (routeBusy || target === currentTransport) return;
		routeBusy = true;
		routeFailure = null;
		try {
			const socket = getSocket();
			if (!socket || !socket.connected) {
				routeFailure = 'offline';
				return;
			}
			await switchCallTransport(socket, target);
		} catch (err) {
			routeError = err;
			routeFailure = 'failed';
		} finally {
			routeBusy = false;
			routeAttempt++;
		}
	}

	function measure(value: number | null | undefined, unit: string): string {
		if (value == null || Number.isNaN(value)) return 'Not measured yet';
		return `${Math.round(value * 10) / 10} ${unit}`;
	}

	function pair(inbound: number | null | undefined, outbound: number | null | undefined, unit: string): string {
		if (inbound == null && outbound == null) return 'Not measured yet';
		const one = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? '—' : `${Math.round(v * 10) / 10}${unit}`);
		return `${one(inbound)} in · ${one(outbound)} out`;
	}

	// ---------- masthead row A ----------

	let moreOpen = $state(false);
	let moreAnchor = $state<HTMLElement | null>(null);
	const cameraOn = $derived(!$isVideoOff);

	const recordLabel = $derived(
		recording ? t('calls.recording', { time: recordElapsed }) : savingRecording ? 'Saving recording…' : t('calls.record')
	);

	function toggleMic(): void {
		if ($isMuted) unmuteAllMic();
		else muteAllMic();
	}
	function toggleSound(): void {
		if ($isDeafened) undeafenAll();
		else deafenAll();
	}

	const moreItems = $derived.by<MenuEntry[]>(() => {
		const items: MenuEntry[] = [];
		if ($isMobile) {
			items.push({
				id: 'record',
				label: recording ? 'Stop recording' : savingRecording ? 'Saving recording…' : t('calls.record'),
				hint: recording ? recordElapsed : undefined,
				disabled: recordBusy || savingRecording,
				onSelect: handleToggleRecord
			});
		}
		items.push({
			id: 'details',
			label: $callConnectionDetailsOpen ? 'Hide connection details' : t('calls.connection_details'),
			icon: 'signal',
			onSelect: () => callConnectionDetailsOpen.update((open) => !open)
		});
		if (cameraOn) items.push({ id: 'camera-off', label: $_('shell.call.turn_off_camera'), icon: 'videoOff', onSelect: cameraOff });
		if ($isMobile) {
			items.push({ id: 'sep', type: 'separator' });
			items.push({ id: 'leave-all', label: t('calls.leave_all'), icon: 'phoneOff', danger: true, onSelect: leaveAllCalls });
		}
		return items;
	});

	const headerActions = $derived.by<StageHeaderAction[]>(() => {
		if (!inCall) return [];
		const phone = $isMobile;
		// Mic and Sound keep one name and report their state with aria-pressed, exactly like the
		// sidebar foot's Mute and Deafen (spec §7.2, §8.1 item 8).
		const mic: StageHeaderAction = {
			id: 'mic',
			label: 'Mute microphone',
			icon: $isMuted ? 'micOff' : 'mic',
			pressed: $isMuted,
			iconOnly: true,
			onSelect: toggleMic
		};
		const sound: StageHeaderAction = {
			id: 'sound',
			label: 'Deafen',
			icon: $isDeafened ? 'headphonesOff' : 'headphones',
			pressed: $isDeafened,
			iconOnly: true,
			onSelect: toggleSound
		};
		const more: StageHeaderAction = {
			id: 'more',
			label: phone ? 'Call options' : t('calls.connection_details'),
			icon: 'more',
			iconOnly: true,
			onSelect: (anchor) => {
				moreAnchor = anchor;
				moreOpen = !moreOpen;
			}
		};
		if (phone) return [mic, sound, more];
		return [
			mic,
			sound,
			{
				id: 'record',
				label: recordLabel,
				variant: recording ? 'danger' : 'default',
				pressed: recording,
				disabled: recordBusy || savingRecording,
				onSelect: () => void handleToggleRecord()
			},
			{ id: 'leave-all', label: t('calls.leave_all'), variant: 'danger', onSelect: leaveAllCalls },
			more
		];
	});

	$effect(() => {
		setStageHeader(HEADER_OWNER, { view: 'voice', title: t('places.calls'), status: summary, actions: headerActions });
	});
	onDestroy(() => clearStageHeader(HEADER_OWNER));

	$effect(() => {
		if (!inCall) moreOpen = false;
	});

	// ---------- rows: Join and Listen ----------

	function attemptFor(channelId: string) {
		return $callJoinAttempts[channelId] ?? null;
	}

	function busyLabel(mode: CallJoinMode, channelId: string): boolean {
		const attempt = attemptFor(channelId);
		return attempt?.status === 'joining' && attempt.mode === mode;
	}

	function retry(channelId: string): void {
		const attempt = attemptFor(channelId);
		void joinVoice(channelId, attempt?.mode ?? 'join');
	}
</script>

<div class="calls">
	{#if inCall && $callConnectionDetailsOpen}
		<section class="calls-conn" aria-labelledby={`${uid}-conn`}>
			<header class="calls-conn__head">
				<h3 class="calls-conn__title" id={`${uid}-conn`}><Icon name="signal" size={16} />{t('calls.connection_details')}</h3>
				<button type="button" class="w-ibtn w-ibtn--sm" aria-label="Close connection details" onclick={() => callConnectionDetailsOpen.set(false)}>
					<Icon name="x" />
				</button>
			</header>
			<dl class="calls-conn__facts">
				<dt>Route</dt>
				<dd>{routeWord}</dd>
				<dt>Latency</dt>
				<dd>{measure($callConnectionDiagnostics.pingMs, 'ms')}</dd>
				<dt>Jitter</dt>
				<dd>{measure($callConnectionDiagnostics.jitterMs, 'ms')}</dd>
				<dt>Packet loss</dt>
				<dd>{pair($callConnectionDiagnostics.inboundPacketLossPct, $callConnectionDiagnostics.outboundPacketLossPct, '%')}</dd>
				<dt>Rate</dt>
				<dd>{pair($callConnectionDiagnostics.inboundKbps, $callConnectionDiagnostics.outboundKbps, ' kbps')}</dd>
			</dl>
			{#if currentTransport === 'wabidb' || currentTransport === 'p2p'}
				<div class="calls-conn__route">
					<span class="calls-conn__label" id={`${uid}-route`}>Route for every call</span>
					{#key routeAttempt}
						<Segmented
							labelledby={`${uid}-route`}
							value={currentTransport}
							disabled={routeBusy}
							options={[
								{ value: 'wabidb', label: t('calls.route_server') },
								{ value: 'p2p', label: t('calls.route_direct') }
							]}
							onchange={(value) => void switchRoute(value as Route)}
						/>
					{/key}
					<p class="calls-conn__hint" aria-live="polite">
						{routeBusy ? 'Changing the route…' : 'Through this server, your Wabi server relays the audio. Direct, the audio goes between devices.'}
					</p>
				</div>
			{/if}
			{#if routeFailure}
				<Notice
					title="Couldn't change the route"
					text={routeFailure === 'offline' ? joinFailureText('offline', true) : 'Your calls stay on the route they were using.'}
					error={routeError}
					ondismiss={() => (routeFailure = null)}
				/>
			{/if}
		</section>
	{/if}

	{#if recordFailure}
		<Notice
			class="calls-notice"
			title={recordFailure === 'start' ? "Couldn't start recording" : "Couldn't stop the recording"}
			text={recordFailure === 'start' ? 'The call goes on without a recording.' : 'Try again; the call goes on.'}
			error={recordError}
			onretry={() => void handleToggleRecord()}
			ondismiss={() => (recordFailure = null)}
		/>
	{/if}

	{#if inCall}
		<section class="calls-section" aria-labelledby={`${uid}-in-call`}>
			<h3 class="calls-kicker" id={`${uid}-in-call`}>
				<span class="w-kicker">{t('calls.in_call')}</span><span class="calls-kicker__rule" aria-hidden="true"></span><span class="w-count">{sessions.length}</span>
			</h3>
			<div class="calls-cards" class:calls-cards--single={sessions.length === 1}>
				{#each sessions as session (session.id)}
					{@const state = sessionState(session, { micMuted: $isMuted })}
					{@const here = state.key === 'mic-here' || state.key === 'muted'}
					{@const faces = sessionFaces(session)}
					{@const recorders = recordersIn(session, faces)}
					{@const videos = sessionVideos(session)}
					{@const room = displayName(session)}
					<article
						class="call-card"
						class:call-card--here={here}
						data-state={state.key}
						data-voice-room={session.channelId ?? undefined}
						aria-labelledby={`${uid}-card-${session.id}`}
					>
						<header class="call-card__head">
							<h4 class="call-card__name" id={`${uid}-card-${session.id}`}>{room}</h4>
							<span class="call-pill" data-state={state.key} title={state.hint}>
								<Icon name={state.icon} size={14} />{callStateWord(state, t)}
							</span>
						</header>

						{#if recorders.length > 0}
							<p class="call-card__rec"><span class="w-dot w-dot--danger" aria-hidden="true"></span>Recording · {recorders.join(', ')}</p>
						{/if}

						{#if videos.length > 0 || (here && ownScreenStream)}
							<div class="call-card__videos">
								{#if here && ownScreenStream}
									<div class="call-tile call-tile--screen">
										<VideoSink stream={ownScreenStream} />
										<span class="call-tile__label"><Icon name="screen" size={12} />Your screen</span>
									</div>
								{/if}
								{#each videos.slice(0, 4) as [key, stream] (key)}
									<div class="call-tile" class:call-tile--screen={key.endsWith(':screen')}>
										<VideoSink {stream} />
										<span class="call-tile__label">
											<Icon name={key.endsWith(':screen') ? 'screen' : 'video'} size={12} />{videoOwnerName(session, key)}
										</span>
									</div>
								{/each}
							</div>
						{/if}

						<div class="call-card__people">
							<ul class="call-faces" aria-label={`People in ${room}`}>
								{#each faces.slice(0, CARD_FACES) as person (person.userId)}
									{@const said = faceState(person)}
									<li class="call-av" class:call-av--speaking={person.speaking} style={person.ink} title={said ? `${person.name} · ${said}` : person.name}>
										{#if person.picture}
											<img src={person.picture} alt="" />
										{:else}
											<span class="call-av__initial" aria-hidden="true">{person.initial}</span>
										{/if}
										{#if person.deafened}
											<span class="call-av__mark" aria-hidden="true"><Icon name="headphonesOff" size={10} /></span>
										{:else if person.muted}
											<span class="call-av__mark" aria-hidden="true"><Icon name="micOff" size={10} /></span>
										{:else if person.listenOnly}
											<span class="call-av__mark" aria-hidden="true"><Icon name="headphones" size={10} /></span>
										{/if}
										<span class="sr-only">{said ? `${person.name}, ${said}` : person.name}</span>
									</li>
								{/each}
								{#if faces.length > CARD_FACES}
									<li class="call-av call-av--more" title={faces.slice(CARD_FACES).map((p) => p.name).join(', ')}>
										<span aria-hidden="true">+{faces.length - CARD_FACES}</span><span class="sr-only">{t('calls.and_more', { count: faces.length - CARD_FACES })}</span>
									</li>
								{/if}
							</ul>
							<span class="call-card__count">{t('calls.in_call_count', { count: faces.length })}</span>
						</div>

						<div class="call-card__volume" style={`--w-range-fill: ${session.volume}%`}>
							<button
								type="button"
								class="w-ibtn w-ibtn--sm call-card__speaker"
								aria-pressed={session.muted}
								aria-label={t('calls.silence_call')}
								title={t('calls.silence_call')}
								onclick={() => toggleCallSpeaker(session.id)}
							>
								<Icon name={session.muted ? 'headphonesOff' : 'voice'} />
							</button>
							<input
								type="range"
								class="w-range"
								min="0"
								max="100"
								step="5"
								value={session.volume}
								oninput={(e) => setCallVolume(session.id, Number((e.currentTarget as HTMLInputElement).value))}
								aria-label={t('calls.volume_for', { room })}
								aria-valuetext={`${session.volume}%`}
							/>
							<span class="call-card__level" aria-hidden="true">{session.volume}%</span>
						</div>

						<div class="call-card__actions">
							{#if !here}
								<button type="button" class="w-btn w-btn--sm" onclick={() => focusCall(session.id)} title={`Send your mic to ${room}`}>
									<Icon name="mic" />Speak here
								</button>
							{/if}
							<button type="button" class="w-btn w-btn--danger w-btn--sm call-card__leave" onclick={() => leaveCall(session)} aria-label={`${t('calls.leave')} ${room}`}>
								{t('calls.leave')}
							</button>
						</div>
					</article>
				{/each}
			</div>
		</section>
	{:else if voiceChannels.length > 0}
		<div class="w-empty calls-empty">
			<Icon name="voice" size={28} />
			<h3 class="w-empty__title">{t('calls.empty_title')}</h3>
			<p class="w-empty__text">{t('calls.empty_body')}</p>
		</div>
	{:else}
		<div class="w-empty calls-empty">
			<Icon name="voice" size={28} />
			<h3 class="w-empty__title">No voice rooms yet</h3>
			<p class="w-empty__text">A voice room shows up here once someone in this community creates one.</p>
		</div>
	{/if}

	{#if otherRooms.length > 0}
		<section class="calls-section" aria-labelledby={`${uid}-rooms`}>
			<h3 class="calls-kicker" id={`${uid}-rooms`}>
				<span class="w-kicker">{inCall ? t('calls.other_rooms') : 'Rooms'}</span><span class="calls-kicker__rule" aria-hidden="true"></span><span class="w-count">{otherRooms.length}</span>
			</h3>
			<ul class="calls-rooms">
				{#each otherRooms as ch (ch.id)}
					{@const people = roomFaces(ch.id)}
					{@const attempt = attemptFor(ch.id)}
					{@const joining = attempt?.status === 'joining'}
					{@const name = ch.name ?? ch.id}
					<li class="calls-room" data-voice-room={ch.id}>
						<div class="calls-room__row">
							<Icon name="voice" class="calls-room__glyph" />
							<span class="calls-room__name">{name}</span>
							{#if people.length > 0}
								<span class="w-dot w-dot--online calls-room__live" aria-hidden="true"></span>
								<span class="calls-room__faces" aria-hidden="true">
									{#each people.slice(0, ROW_FACES) as person (person.userId)}
										<span class="call-av call-av--sm" style={person.ink} title={person.name}>
											{#if person.picture}<img src={person.picture} alt="" />{:else}<span class="call-av__initial">{person.initial}</span>{/if}
										</span>
									{/each}
								</span>
							{/if}
							{#if people.length > 0}<span class="calls-room__count">{t('calls.in_call_count', { count: people.length })}</span>{/if}
							<span class="calls-room__actions">
								<button
									type="button"
									class="w-btn w-btn--quiet"
									aria-busy={busyLabel('listen', ch.id)}
									aria-disabled={joining && !busyLabel('listen', ch.id) ? 'true' : undefined}
									aria-label={`${t('calls.listen')} to ${name}`}
									onclick={() => !joining && void joinVoice(ch.id, 'listen')}
								>
									<span class="w-btn__swap"><span>{t('calls.listen')}</span><span>{t('calls.joining')}</span></span>
								</button>
								<button
									type="button"
									class="w-btn"
									aria-busy={busyLabel('join', ch.id)}
									aria-disabled={joining && !busyLabel('join', ch.id) ? 'true' : undefined}
									aria-label={`${t('calls.join')} ${name}`}
									onclick={() => !joining && void joinVoice(ch.id, 'join')}
								>
									<span class="w-btn__swap"><span>{t('calls.join')}</span><span>{t('calls.joining')}</span></span>
								</button>
							</span>
						</div>
						{#if attempt?.status === 'failed'}
							<Notice
								class="calls-room__notice"
								title={t('calls.join_failed', { room: name })}
								text={joinFailureText(attempt.failure, inCall)}
								onretry={() => retry(ch.id)}
								ondismiss={() => dismissJoinFailure(ch.id)}
							/>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>

{#if inCall}
	<Menu items={moreItems} label="Call options" anchor={moreAnchor} bind:open={moreOpen} align="end" />
{/if}
