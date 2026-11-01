<script lang="ts">
	/**
	 * Phase 3 — the focused channel stage (runes), design contract §8.5.
	 *
	 * Audio only: a calm room, a centred grid of 88px stamps with names, speaking rings, mic-off
	 * and listening marks and a word under each (at most four rows, then "and N more").
	 * With video or a shared screen: 16:9 tiles on --w-sink, and the people as a compact row.
	 * With spatial hearing on, "Arrange seats" (the call header's Call options) opens a seat map
	 * that places each voice in 3D audio space (personal layout, persisted per call;
	 * auto-circle is the default seating).
	 *
	 * Replaces CallParticipantGrid for channel mode only; DM calls keep the legacy grid.
	 */
	import { wabidbRemoteVideoSessions, wabidbLocalPreviewSessions } from '$lib/wabidbVideoLane';
	import { localScreenShareSessionId } from '$lib/callingStateStores';
	import { voiceChannelMembers } from '$lib/presenceStore';
	import { applySpatialSeat, applySpatialSeatToAudio, clearSpatialSeat, localScreenStream, screenShares } from '$lib/calling';
	import { computeSpatialPosition, loadSpatialSeats, sortByUserId } from '$lib/callingSpatialRuntime';
	import { mergeScreenShareEntries } from '$lib/callRenderModel';
	import type { CallSession, CallSpatialPosition } from '$lib/callSessionTypes';
	import { currentUser, users, serverMembers } from '$lib/socket';
	import { mediaUrl } from '$lib/mediaUrl';
	import { resolveUserDisplayColor } from '$lib/accessibility';
	import { inkFor } from '$lib/theme/identity';
	import { stampColumns, visibleStamps, voiceStateWord } from '$lib/callShell';
	import Icon from './ui/Icon.svelte';
	import VideoSink from './VideoSink.svelte';

	function streamOwner(key: string): string {
		return key.replace(/:(camera|screen)$/, '');
	}

	let {
		session,
		spatialEnabled = false,
		seatsOpen = $bindable(false)
	}: {
		session: CallSession;
		spatialEnabled?: boolean;
		/** The seat map; the call header's "Arrange seats" opens it. */
		seatsOpen?: boolean;
	} = $props();

	// Live roster for this channel (speaking rings, avatars, mute chips);
	// falls back to the session's snapshot when the roster is cold.
	let roster = $derived(
		(session.channelId ? $voiceChannelMembers[session.channelId] : undefined) ?? []
	);
	let rawParticipants = $derived(
		roster.length > 0
			? roster.map((m: any) => ({
					userId: m.userId as string,
					username: (m.username ?? '') as string,
					isMuted: Boolean(m.isMuted),
					isSpeaking: Boolean(m.isSpeaking),
					isListenOnly: Boolean(m.isListeningOnly),
					avatarUrl: (m.profilePicture ?? null) as string | null
				}))
			: session.participants.map((p) => ({ ...p, isSpeaking: false, avatarUrl: null as string | null }))
	);

	let participants = $derived(rawParticipants.map(person => {
		const profile = [$currentUser, ...$users, ...$serverMembers].find(user => user && (user.id === person.userId || `user-${user.dbUserId}` === person.userId));
		return {
			...person,
			avatarUrl: person.avatarUrl || profile?.profilePicture || null,
			color: profile ? resolveUserDisplayColor(profile.roleColor, profile.color) : ''
		};
	}));

	// A participant may be present in several calls with different feeds.
	let sessionVideo = $derived($wabidbRemoteVideoSessions.get(session.id) ?? new Map<string, MediaStream>());
	let localPreviews = $derived($wabidbLocalPreviewSessions.get(session.id));
	let videoEntries = $derived(
		[...sessionVideo.entries()].filter(([key]) =>
			participants.some((p) => key === `${p.userId}:camera` || key === `${p.userId}:screen`)
		)
	);
	let cameraEntries = $derived(videoEntries.filter(([key]) => !key.endsWith(':screen')));
	let localCamera = $derived(localPreviews?.get('camera') ?? null);

	// Screen tiles span BOTH transports (round 5): wabidb `:screen` streams,
	// P2P `screenShares` (invisible here after "Swap to P2P" before), and the
	// sharer's own preview (the lane self-filters own streams, so without an
	// explicit tile the sharer never sees confirmation on this stage).
	let displayNames = $derived.by(() => {
		const names: Record<string, string> = {};
		for (const p of participants) {
			if (p.username) names[p.userId] = p.username;
		}
		return names;
	});
	let localScreenPreview = $derived(
		localPreviews?.get('screen') ?? ($localScreenShareSessionId === session.id ? $localScreenStream : null)
	);
	let mergedScreenEntries = $derived(
		mergeScreenShareEntries(sessionVideo, $screenShares.filter(share => (share.channelId ?? null) === session.channelId), localScreenPreview, displayNames)
	);
	let participantIds = $derived(new Set(participants.map((p) => p.userId)));
	let screenEntries = $derived(
		mergedScreenEntries.filter((entry) => entry.isLocal || participantIds.has(entry.ownerId))
	);

	function initial(username: string): string {
		return (username || '?').trim().charAt(0).toUpperCase();
	}

	// --- Audio room: as many stamp columns as the stage holds, four rows at most ---
	let hasMedia = $derived(screenEntries.length > 0 || cameraEntries.length > 0 || Boolean(localCamera));
	let roomWidth = $state(0);
	// Phone-width stages use 104px cells 16px apart (call-stage.css, @container stage < 600px).
	let narrowRoom = $derived(roomWidth > 0 && roomWidth < 568);
	let roomColumns = $derived(narrowRoom ? stampColumns(roomWidth, 104, 16) : stampColumns(roomWidth));
	let room = $derived(visibleStamps(participants, roomColumns));

	// --- Spatial seat stage -------------------------------------------------
	let manualSeats = $state<Record<string, CallSpatialPosition>>({});
	let stageEl: HTMLElement | undefined = $state();
	let dragUserId: string | null = $state(null);

	// Reload seats ONLY when the focused call actually changes. Guard on the
	// id: the session prop is a fresh object on every map mutation (roster
	// snapshots, volume ticks) and an unguarded effect would reload the seats
	// and slam the stage shut mid-drag.
	let loadedSeatsForSession = '';

	/**
	 * Push every participant's seat (manual or auto-circle) into the audio
	 * paths — relay chains and the p2p engine — AUDIO ONLY (no store write,
	 * no persistence): bulk writes would freeze auto-circle layouts into
	 * manual seats and re-trigger this effect in a loop. Manual seats are
	 * persisted by the drag handler via applySpatialSeat.
	 */
	function applyAllSeats(): void {
		if (!spatialEnabled) return;
		const ids = orderedIds;
		for (const userId of ids) {
			applySpatialSeatToAudio(session.id, userId, seatFor(userId));
		}
	}

	$effect(() => {
		const id = session.id;
		if (!id || id === loadedSeatsForSession) return;
		loadedSeatsForSession = id;
		manualSeats = loadSpatialSeats(id);
		seatsOpen = false;
		applyAllSeats();
	});

	// Keep the audio paths current: apply every seat (manual or auto-circle)
	// on mount, on roster changes, and on spatial toggles — so a new speaker
	// never lands at dead-center while spatial hearing is on. Skipped
	// mid-drag: the drag handler already applies the moving seat, and
	// re-applying every participant per pointermove would thrash.
	$effect(() => {
		void orderedIds;
		if (!spatialEnabled || dragUserId) return;
		applyAllSeats();
	});

	let orderedIds = $derived(sortByUserId(participants).map((p) => p.userId));

	function seatFor(userId: string): CallSpatialPosition {
		const manual = manualSeats[userId];
		if (manual) return manual;
		const index = Math.max(0, orderedIds.indexOf(userId));
		return computeSpatialPosition(index, Math.max(orderedIds.length, 1));
	}

	/** World x/z (±6) → stage percentage. */
	function seatStyle(userId: string): string {
		const seat = seatFor(userId);
		const left = 50 + (Math.max(-6, Math.min(6, seat.x)) / 12) * 100;
		const top = 50 + (Math.max(-6, Math.min(6, seat.z)) / 12) * 100;
		return `left: ${left}%; top: ${top}%;`;
	}

	function onSeatPointerDown(event: PointerEvent, userId: string): void {
		if (!spatialEnabled) return;
		dragUserId = userId;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		event.preventDefault();
		event.stopPropagation();
	}

	function onSeatPointerMove(event: PointerEvent): void {
		if (!dragUserId || !stageEl) return;
		const rect = stageEl.getBoundingClientRect();
		const x = ((event.clientX - rect.left) / rect.width - 0.5) * 12;
		const z = ((event.clientY - rect.top) / rect.height - 0.5) * 12;
		const position: CallSpatialPosition = {
			x: Math.max(-6, Math.min(6, x)),
			y: 0,
			z: Math.max(-6, Math.min(6, z))
		};
		manualSeats = { ...manualSeats, [dragUserId]: position };
		applySpatialSeat(session.id, dragUserId, position);
	}

	function onSeatPointerUp(): void {
		dragUserId = null;
	}

	function resetSeat(userId: string): void {
		const next = { ...manualSeats };
		delete next[userId];
		manualSeats = next;
		clearSpatialSeat(session.id, userId);
	}
	function dismissSeats(event: PointerEvent) {
		if (seatsOpen && !(event.target as Element)?.closest('.cstage-seats')) seatsOpen = false;
	}
</script>
<svelte:window onpointerdown={dismissSeats} onkeydown={event => { if (seatsOpen && event.key === 'Escape') { event.preventDefault(); seatsOpen = false; } }} />

<div class="cstage" class:cstage--media={hasMedia}>
	{#if !hasMedia}
		<!-- The audio room: who is here, who is talking, who is muted or only listening. -->
		<div class="cstage-room" bind:clientWidth={roomWidth}>
			<ul class="cstage-people" aria-label="People in this call">
				{#each room.shown as p (p.userId)}
					{@const state = voiceStateWord(p)}
					<li
						class="cstage-person"
						class:speaking={p.isSpeaking && !p.isMuted}
						class:muted={p.isMuted}
						class:listening={p.isListenOnly}
					>
						<span class="cstage-stamp" class:cstage-stamp--pic={Boolean(p.avatarUrl)} style={$inkFor(p.color)}>
							{#if p.avatarUrl}
								<img class="cstage-stamp__img" src={mediaUrl(p.avatarUrl)} alt="" />
							{:else}
								<span class="cstage-stamp__initial" aria-hidden="true">{initial(p.username || p.userId)}</span>
							{/if}
							{#if p.isMuted}
								<span class="cstage-mark cstage-mark--muted" aria-hidden="true"><Icon name="micOff" size={14} /></span>
							{:else if p.isListenOnly}
								<span class="cstage-mark" aria-hidden="true"><Icon name="headphones" size={14} /></span>
							{/if}
						</span>
						<span class="cstage-person__name">{p.username || p.userId}</span>
						<span class="cstage-person__state">
							{#if state === 'Speaking'}<Icon name="voice" size={12} />{/if}{state ?? ''}
						</span>
					</li>
				{/each}
				{#if room.more > 0}
					<li class="cstage-person cstage-person--more">
						<span class="cstage-stamp cstage-stamp--more" aria-hidden="true">{room.more}</span>
						<span class="cstage-person__name">and {room.more} more</span>
						<span class="cstage-person__state"></span>
					</li>
				{/if}
			</ul>
		</div>
	{:else}
		<ul class="cstage-roster" aria-label="People in this call">
			{#each participants as p (p.userId)}
				<li class="cstage-chip" class:speaking={p.isSpeaking && !p.isMuted} class:listening={p.isListenOnly}>
					<span class="cstage-chip__stamp" style={$inkFor(p.color)}>
						{#if p.avatarUrl}
							<img src={mediaUrl(p.avatarUrl)} alt="" />
						{:else}
							<span aria-hidden="true">{initial(p.username || p.userId)}</span>
						{/if}
					</span>
					<span class="cstage-chip__name">{p.username || p.userId}</span>
					{#if p.isMuted}
						<Icon name="micOff" size={14} label="Muted" />
					{:else if p.isListenOnly}
						<Icon name="headphones" size={14} label="Listening" />
					{/if}
				</li>
			{/each}
		</ul>

		<div class="cstage-body">
			{#if screenEntries.length > 0}
				<div class="cstage-hero">
					{#each screenEntries as share (share.key)}
						<div class="cstage-hero-item" class:own={share.isLocal} class:speaking={participants.some(p => p.userId === share.ownerId && p.isSpeaking)}>
							<VideoSink stream={share.stream} />
							<span class="cstage-tile-label"><Icon name="monitor" size={12} />{share.label}</span>
						</div>
					{/each}
				</div>
			{/if}

			{#if localCamera || cameraEntries.length > 0}
				<div class="cstage-tiles" class:has-hero={screenEntries.length > 0}>
					{#if localCamera}
						<div class="cstage-tile cstage-tile-local">
							<VideoSink stream={localCamera} mirror />
							<span class="cstage-tile-label">You</span>
						</div>
					{/if}
					{#each cameraEntries as [key, stream] (key)}
						{@const userId = streamOwner(key)}
						{@const who = participants.find((p) => p.userId === userId)}
						<div class="cstage-tile" class:speaking={who?.isSpeaking}>
							<VideoSink {stream} />
							<span class="cstage-tile-label">{who?.username || userId}</span>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}

	{#if spatialEnabled && seatsOpen}
		<section class="cstage-seats" aria-labelledby={`call-spatial-seats-title-${session.id}`}>
			<header class="cstage-seats__head">
				<h3 class="cstage-seats__title" id={`call-spatial-seats-title-${session.id}`}>Arrange seats</h3>
				<button
					type="button"
					class="w-ibtn w-ibtn--sm"
					aria-label="Close seats"
					title="Close seats"
					onclick={() => (seatsOpen = false)}
				><Icon name="x" size={16} /></button>
			</header>
			<p class="cstage-seats__hint">Drag a person to place their voice around you. Arrow keys move a seat; Enter resets it.</p>
			<div
				id={`call-spatial-seats-${session.id}`}
				class="cstage-seatmap"
				role="application"
				aria-label="Spatial seating stage — drag avatars to position them"
				bind:this={stageEl}
				onpointermove={onSeatPointerMove}
				onpointerup={onSeatPointerUp}
				onpointercancel={onSeatPointerUp}
			>
				<span class="cstage-seat-center" title="You (listener)">
					<Icon name="headphones" size={20} />
				</span>
				{#each participants as p (p.userId)}
					<div
						class="cstage-seat-chip"
						class:dragging={dragUserId === p.userId}
						class:manual={Boolean(manualSeats[p.userId])}
						style={seatStyle(p.userId)}
						role="button"
						tabindex="0"
						aria-label={`Seat for ${p.username || p.userId}`}
						onpointerdown={(e) => onSeatPointerDown(e, p.userId)}
						ondblclick={() => resetSeat(p.userId)}
						onkeydown={(e) => {
							if (e.key === 'Enter' || e.key === 'Home') { e.preventDefault(); resetSeat(p.userId); }
							if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) {
								e.preventDefault(); const seat = seatFor(p.userId);
								const position = { x: Math.max(-6, Math.min(6, seat.x + (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0))), y: 0, z: Math.max(-6, Math.min(6, seat.z + (e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0))) };
								manualSeats = { ...manualSeats, [p.userId]: position }; applySpatialSeat(session.id, p.userId, position);
							}
						}}
						title={manualSeats[p.userId] ? 'Double-click to reset to auto-circle' : ''}
					>
						<span class="cstage-chip__stamp" style={$inkFor(p.color)}>
							{#if p.avatarUrl}
								<img src={mediaUrl(p.avatarUrl)} alt="" />
							{:else}
								<span aria-hidden="true">{initial(p.username || p.userId)}</span>
							{/if}
						</span>
						<span class="cstage-seat-name">{p.username || p.userId}</span>
					</div>
				{/each}
			</div>
		</section>
	{/if}
</div>
