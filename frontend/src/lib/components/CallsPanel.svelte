<script lang="ts">
	/**
	 * Calls in the companion panel (design contract §7.21, §8.5 "Right-panel Calls"): compact rows
	 * for the calls you are in, beside whatever owns center stage. The frame's row A already names
	 * the panel ("Calls" + count), so this body draws no title of its own.
	 *
	 * Each row: the room, your state word in the same vocabulary as the Calls page ("Mic here",
	 * "Listening", "Silent"), the people as real stamps, then "Silence this call", the volume
	 * ("Volume for <room>"), "Speak here" and "Leave". The panel never takes over center stage:
	 * "Open Calls" is an explicit choice.
	 */
	import { onDestroy } from 'svelte';
	import { _ } from '$lib/i18n';
	import { callSessions } from '$lib/callSessionManager';
	import { callStateWord, sessionState, type CallCopy, type CallSession } from '$lib/callSessionTypes';
	import { channels } from '$lib/channelStore';
	import { voiceChannelMembers } from '$lib/presenceStore';
	import { users, serverMembers } from '$lib/socket';
	import { activeCalls, isMuted, speakingUsers } from '$lib/calling';
	import { leaveCall, focusCall, setCallVolume, toggleCallSpeaker } from '$lib/callSurfaces';
	import { setPanelFrameCount } from '$lib/workspacePanels';
	import { selectWorkspaceView } from '$lib/workspaceNavigationState';
	import { inkFor } from '$lib/theme/identity';
	import { mediaUrl } from '$lib/mediaUrl';
	import Icon from './ui/Icon.svelte';

	/** Stamps in a row before "+N" (the 304px panel keeps them on one line). */
	const FACES = 5;

	const t: CallCopy = (key, values) => $_(key, values ? { values } : undefined);

	let sessions = $derived(
		[...$callSessions.values()].sort((a, b) => {
			if (a.focus === 'focused') return -1;
			if (b.focus === 'focused') return 1;
			return b.joinedAt - a.joinedAt;
		})
	);

	// The frame's row A shows the count; no count while there is nothing to count.
	$effect(() => {
		setPanelFrameCount('calls', sessions.length > 0 ? sessions.length : null);
	});
	onDestroy(() => setPanelFrameCount('calls', null));

	// Sessions register with `name: channelId` as a placeholder: resolve the real channel name.
	function displayName(session: { id: string; name?: string | null; channelId?: string | null }): string {
		return (session.channelId ? $channels.find((c) => c.id === session.channelId)?.name : undefined) ?? session.name ?? session.id;
	}

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
	}

	function face(member: { userId: string; username?: string | null; profilePicture?: string | null; isSpeaking?: boolean }): Face {
		const name = member.username || member.userId;
		return {
			userId: member.userId,
			name,
			initial: (name.trim().charAt(0) || '?').toUpperCase(),
			picture: member.profilePicture ? mediaUrl(member.profilePicture) : null,
			ink: $inkFor(memberColors.get(member.userId)),
			speaking: Boolean(member.isSpeaking) || $speakingUsers.has(member.userId)
		};
	}

	// A channel's roster carries pictures; DM/group sessions fall back to the live call list (review F4).
	function sessionFaces(session: CallSession): Face[] {
		const roster = session.channelId ? ($voiceChannelMembers[session.channelId] ?? null) : null;
		if (roster && roster.length > 0) return roster.map((m) => face(m));
		if (session.kind !== 'channel' && session.participants.length === 0) {
			return $activeCalls.map((call) => face({ userId: call.userId, username: call.username ?? call.userId }));
		}
		return session.participants.map((p) => face(p));
	}
</script>

<div class="calls-panel">
	{#if sessions.length === 0}
		<div class="calls-panel__empty">
			<Icon name="voice" size={28} />
			<p class="calls-panel__empty-title">{t('calls.empty_title')}</p>
			<p class="calls-panel__empty-text">Join a voice room from the sidebar. Every room is listed in Calls.</p>
			<button type="button" class="w-btn w-btn--sm" onclick={() => selectWorkspaceView('voice')}>Open Calls</button>
		</div>
	{:else}
		<ul class="calls-panel__list">
			{#each sessions as session (session.id)}
				{@const state = sessionState(session, { micMuted: $isMuted })}
				{@const here = state.key === 'mic-here' || state.key === 'muted'}
				{@const faces = sessionFaces(session)}
				{@const room = displayName(session)}
				<li class="calls-row" class:calls-row--here={here} data-state={state.key} aria-label={`${room}, ${callStateWord(state, t)}`}>
					<div class="calls-row__head">
						<span class="calls-row__name">{room}</span>
						<span class="call-pill call-pill--sm" data-state={state.key} title={state.hint}>
							<Icon name={state.icon} size={12} />{callStateWord(state, t)}
						</span>
					</div>
					<div class="calls-row__people">
						<span class="calls-row__faces" aria-hidden="true">
							{#each faces.slice(0, FACES) as person (person.userId)}
								<span class="call-av call-av--sm" class:call-av--speaking={person.speaking} style={person.ink} title={person.name}>
									{#if person.picture}<img src={person.picture} alt="" />{:else}<span class="call-av__initial">{person.initial}</span>{/if}
								</span>
							{/each}
							{#if faces.length > FACES}<span class="call-av call-av--sm call-av--more">+{faces.length - FACES}</span>{/if}
						</span>
						<span class="calls-row__count">{t('calls.in_call_count', { count: faces.length })}</span>
					</div>
					<div class="calls-row__controls" style={`--w-range-fill: ${session.volume}%`}>
						<button
							type="button"
							class="w-ibtn w-ibtn--sm"
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
						<span class="calls-row__level" aria-hidden="true">{session.volume}%</span>
						{#if !here}
							<button type="button" class="w-ibtn w-ibtn--sm" aria-label={`Speak here: send your mic to ${room}`} title="Speak here" onclick={() => focusCall(session.id)}>
								<Icon name="mic" />
							</button>
						{/if}
						<button type="button" class="w-btn w-btn--danger w-btn--sm" aria-label={`${t('calls.leave')} ${room}`} onclick={() => leaveCall(session)}>
							{t('calls.leave')}
						</button>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>
