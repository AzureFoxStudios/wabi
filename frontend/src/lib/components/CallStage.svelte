<script lang="ts">
	/**
	 * Phase 3 — the focused channel stage (runes).
	 *
	 * Goal 3 surface: avatar chips for every roster member, proper camera +
	 * screen-share tiles, and — when spatial hearing is on — a draggable
	 * seat stage that positions each speaker in 3D audio space (personal
	 * layout, persisted per call; auto-circle is the default seating).
	 *
	 * Replaces CallParticipantGrid for channel mode only; DM calls keep the
	 * legacy grid this pass.
	 */
	import { wabidbRemoteVideoStreams, wabidbLocalPreviewStreams } from '$lib/wabidbVideoLane';
	import { voiceChannelMembers } from '$lib/presenceStore';
	import { applySpatialSeat, applySpatialSeatToAudio, clearSpatialSeat, localScreenStream, screenShares } from '$lib/calling';
	import { computeSpatialPosition, loadSpatialSeats, sortByUserId } from '$lib/callingSpatialRuntime';
	import { mergeScreenShareEntries } from '$lib/callRenderModel';
	import type { CallSession, CallSpatialPosition } from '$lib/callSessionTypes';
	import VideoSink from './VideoSink.svelte';

	function streamOwner(key: string): string {
		return key.replace(/:(camera|screen)$/, '');
	}

	let {
		session,
		spatialEnabled = false
	}: {
		session: CallSession;
		spatialEnabled?: boolean;
	} = $props();

	// Live roster for this channel (speaking rings, avatars, mute chips);
	// falls back to the session's snapshot when the roster is cold.
	let roster = $derived(
		(session.channelId ? $voiceChannelMembers[session.channelId] : undefined) ?? []
	);
	let participants = $derived(
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

	// Remote video for THIS call's users only — the wabidb video lane's
	// stream store is global across calls, so filter by participant ids.
	let videoEntries = $derived(
		[...$wabidbRemoteVideoStreams.entries()].filter(([key]) =>
			participants.some((p) => key === `${p.userId}:camera` || key === `${p.userId}:screen`)
		)
	);
	let cameraEntries = $derived(videoEntries.filter(([key]) => !key.endsWith(':screen')));
	let localCamera = $derived($wabidbLocalPreviewStreams.get('camera') ?? null);

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
		$wabidbLocalPreviewStreams.get('screen') ?? $localScreenStream ?? null
	);
	let mergedScreenEntries = $derived(
		mergeScreenShareEntries($wabidbRemoteVideoStreams, $screenShares, localScreenPreview, displayNames)
	);
	let participantIds = $derived(new Set(participants.map((p) => p.userId)));
	let screenEntries = $derived(
		mergedScreenEntries.filter((entry) => entry.isLocal || participantIds.has(entry.ownerId))
	);

	function initial(username: string): string {
		return (username || '?').trim().charAt(0).toUpperCase();
	}

	// --- Spatial seat stage -------------------------------------------------
	let seatsOpen = $state(false);
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
</script>

<div class="cstage">
	<div class="cstage-chips" aria-label="Call participants">
		{#each participants as p (p.userId)}
			<span
				class="cstage-chip"
				class:speaking={p.isSpeaking}
				class:muted={p.isMuted}
				class:listening={p.isListenOnly}
				title={`${p.username || p.userId}${p.isListenOnly ? ' (listening)' : ''}`}
			>
				{#if p.avatarUrl}
					<img class="cstage-chip-avatar" src={p.avatarUrl} alt={p.username || p.userId} />
				{:else}
					<span class="cstage-chip-initial">{initial(p.username || p.userId)}</span>
				{/if}
				<span class="cstage-chip-name">{p.username || p.userId}</span>
				{#if p.isMuted}<span class="cstage-chip-icon" title="Muted" aria-label="Muted"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg></span>{/if}
			</span>
		{/each}
	</div>

	<div class="cstage-body">
		{#if screenEntries.length > 0}
			<div class="cstage-hero">
				{#each screenEntries as share (share.key)}
					<div class="cstage-hero-item" class:own={share.isLocal}>
						<VideoSink stream={share.stream} />
						<span class="cstage-tile-label"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> {share.label}</span>
					</div>
				{/each}
			</div>
		{/if}

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
			{#if cameraEntries.length === 0 && !localCamera}
				<div class="cstage-empty">
					<span class="cstage-empty-hint">
						{participants.length} in call — no camera or screen share yet
					</span>
				</div>
			{/if}
		</div>

		{#if spatialEnabled}
			<div class="cstage-seatbar">
				<button
					type="button"
					class="cstage-seat-toggle"
					class:active={seatsOpen}
					onclick={() => (seatsOpen = !seatsOpen)}
					title="Arrange the spatial hearing stage"
				>
					<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1.6"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M8.46 8.46a5 5 0 0 0 0 7.07"/><path d="M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
					Seats
				</button>
				{#if seatsOpen}
					<span class="cstage-seat-hint">Drag avatars to position them in 3D space</span>
				{/if}
			</div>
			{#if seatsOpen}
				<div
					class="cstage-seatmap"
					role="application"
					aria-label="Spatial seating stage — drag avatars to position them"
					bind:this={stageEl}
					onpointermove={onSeatPointerMove}
					onpointerup={onSeatPointerUp}
					onpointercancel={onSeatPointerUp}
				>
					<span class="cstage-seat-center" title="You (listener)">
						<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>
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
							onkeydown={(e) => e.key === 'Enter' && resetSeat(p.userId)}
							title={manualSeats[p.userId] ? 'Double-click to reset to auto-circle' : ''}
						>
							{#if p.avatarUrl}
								<img class="cstage-chip-avatar" src={p.avatarUrl} alt={p.username || p.userId} />
							{:else}
								<span class="cstage-chip-initial">{initial(p.username || p.userId)}</span>
							{/if}
							<span class="cstage-seat-name">{p.username || p.userId}</span>
						</div>
					{/each}
				</div>
			{/if}
		{/if}
	</div>
</div>
