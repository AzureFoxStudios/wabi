<!--
	The sidebar voice status row (design contract §8.1 item 7), only while you are in a voice room:
	a 56px row above the foot with the live dot, the room your mic goes to, and one line saying
	where your mic goes and how many more rooms you hear ("Mic here · listening to 2 more", or
	"Mic in all rooms I hear" under "Send my mic to: All rooms I hear"), then a 28px ⋯ (Call
	options) and a 28px Leave. Where the mic goes follows the audio path (`micGoesTo` in
	lib/callSessionTypes.ts), never the session focus alone.

	- The ⋯ menu holds what used to be raw selects and chips: where your mic goes ("This room" /
	  "All rooms I hear"), the rooms you listen to (the same session list the line counts; uncheck
	  to stop listening), the time-in-call
	  setting, the camera and screen share, and "Connection details", which open on the Calls page
	  (one surface for route, latency and packet loss; §9.5).
	- Recording lives in one control (the Calls masthead and the call dock), not here.
	- Words come from the session model (lib/callSessionTypes.ts), never a transport or lifecycle
	  enum.
	Legacy (Svelte 4) syntax kept on purpose: all reactivity flows through top-level `$:`
	derivations and the template reads only those (svelte5ReactivityTripwire.test.ts).
-->
<script lang="ts">
	import type { Channel } from '$lib/socket';
	import { _ } from '$lib/i18n';
	import {
		callMode,
		voiceTransmitMode,
		isVideoOff,
		isSharing,
		canScreenShare,
		isMuted as callMuted,
		isDeafened as callDeafened,
		toggleVideo,
		startScreenShare,
		stopScreenShare
	} from '$lib/calling';
	import { getSocket } from '$lib/socketConnection';
	import { callSessions } from '$lib/callSessionManager';
	import { voiceStatusLine, type CallCopy, type CallSession } from '$lib/callSessionTypes';
	import { leaveCall, openConnectionDetails } from '$lib/callSurfaces';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import type { MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';

	export let runtimeActiveVoiceChannelId: string | null;
	export let voiceChannels: Channel[];
	export let voiceDurationMode: 'off' | 'others' | 'all';

	export let onToggleListenChannel: (channelId: string) => void;
	export let onTransmitModeChange: (event: Event) => void;
	export let onSetVoiceDurationMode: (mode: 'off' | 'others' | 'all') => void;
	export let onLeaveVoice: () => Promise<void>;

	// ============================================================================
	// SVELTE 5 REACTIVITY CONTRACT (do not regress)
	// ============================================================================
	// Template expressions that call script functions compile to
	// `$.untrack(() => fn(args))` in Svelte 5 legacy mode: args stay tracked but
	// store/prop reads INSIDE the body register no dependency. All reactivity
	// flows through top-level `$:` derivations below; the template only
	// references the derived values.

	function resolveChannelName(channelId: string | null, list: Channel[]): string {
		if (!channelId) return '';
		return list.find((channel) => channel.id === channelId)?.name || channelId;
	}

	function sessionName(session: CallSession, list: Channel[]): string {
		return (session.channelId ? list.find((channel) => channel.id === session.channelId)?.name : undefined) || session.name || session.id;
	}

	type Translate = (key: string, options?: { values?: Record<string, string | number> }) => string;
	function makeCopy(translate: Translate): CallCopy {
		return (key, values) => translate(key, values ? { values } : undefined);
	}

	$: copy = makeCopy($_);
	$: connectionLabel = copy('calls.connection_details');
	$: optionsLabel = 'Call options';

	$: sessionList = [...$callSessions.values()];
	$: status = voiceStatusLine(sessionList, { micMuted: $callMuted, deafened: $callDeafened, transmitMode: $voiceTransmitMode, t: copy });
	// The legacy primary-channel state, for a join the session model has not registered yet.
	$: legacyActive = $callMode === 'channel' && Boolean(runtimeActiveVoiceChannelId);
	$: visible = Boolean(status) || legacyActive;
	$: roomName = status ? sessionName(status.session, voiceChannels) : resolveChannelName(runtimeActiveVoiceChannelId, voiceChannels);
	$: line = status
		? status.line
		: $voiceTransmitMode === 'all-listening'
			? 'Mic in all rooms I hear'
			: $callMuted
				? copy('calls.muted')
				: copy('sidebar.mic_here');
	$: pending = status?.pending ?? false;
	$: leaveLabel = roomName ? `${copy('calls.leave')} ${roomName}` : $_('shell.call.leave_voice');

	// The other rooms the line counts ("listening to 2 more"), from the same session list:
	// unchecking one stops listening there. The primary room is left with Leave instead.
	$: listenedRooms = sessionList
		.filter((session) => session.kind === 'channel' && session.id !== status?.session.id)
		.map((session) => ({ id: session.channelId ?? session.id, name: sessionName(session, voiceChannels) }))
		.filter((room) => room.id !== runtimeActiveVoiceChannelId);

	function chooseTransmit(mode: 'primary' | 'all-listening') {
		// The sidebar's handler reads the chosen value from the event target (it served a select).
		onTransmitModeChange({ currentTarget: { value: mode } } as unknown as Event);
	}

	async function handleToggleVideo() {
		await toggleVideo(getSocket() || undefined);
	}

	async function handleToggleScreenShare() {
		const sock = getSocket();
		if (!sock) return;
		if ($isSharing) {
			stopScreenShare(sock);
		} else {
			try {
				await startScreenShare(sock);
			} catch {
				// The share picker was dismissed; nothing changed.
			}
		}
	}

	function handleLeave() {
		// Leave the room this row names (a failure says so in a toast); before the session model has
		// it, leave the primary room through the sidebar, which reports failures the same way.
		if (status) leaveCall(status.session, roomName);
		else void onLeaveVoice();
	}

	$: menuItems = ((): MenuEntry[] => {
		const items: MenuEntry[] = [
			{ id: 'mic-kicker', type: 'kicker', label: 'Send my mic to' },
			{ id: 'mic-room', label: 'This room', role: 'menuitemradio', checked: $voiceTransmitMode !== 'all-listening', onSelect: () => chooseTransmit('primary') },
			{ id: 'mic-all', label: 'All rooms I hear', role: 'menuitemradio', checked: $voiceTransmitMode === 'all-listening', onSelect: () => chooseTransmit('all-listening') }
		];
		if (listenedRooms.length > 0) {
			items.push({ id: 'listen-kicker', type: 'kicker', label: 'Listening to' });
			for (const room of listenedRooms) {
				items.push({ id: `listen-${room.id}`, label: room.name, keepCase: true, role: 'menuitemcheckbox', checked: true, onSelect: () => onToggleListenChannel(room.id) });
			}
		}
		items.push(
			{ id: 'time-kicker', type: 'kicker', label: 'Show time in call' },
			{ id: 'time-off', label: 'Off', role: 'menuitemradio', checked: voiceDurationMode === 'off', onSelect: () => onSetVoiceDurationMode('off') },
			{ id: 'time-others', label: 'For others', role: 'menuitemradio', checked: voiceDurationMode === 'others', onSelect: () => onSetVoiceDurationMode('others') },
			{ id: 'time-all', label: 'For everyone', role: 'menuitemradio', checked: voiceDurationMode === 'all', onSelect: () => onSetVoiceDurationMode('all') },
			{ id: 'media-sep', type: 'separator' },
			{ id: 'camera', label: $isVideoOff ? $_('shell.call.turn_on_camera') : $_('shell.call.turn_off_camera'), icon: $isVideoOff ? 'video' : 'videoOff', onSelect: handleToggleVideo }
		);
		if (canScreenShare()) {
			items.push({ id: 'screen', label: $isSharing ? 'Stop sharing your screen' : copy('calls.share_screen'), icon: 'screen', onSelect: handleToggleScreenShare });
		}
		items.push(
			{ id: 'details-sep', type: 'separator' },
			{ id: 'details', label: connectionLabel, icon: 'signal', onSelect: openConnectionDetails }
		);
		return items;
	})();
</script>

{#if visible}
	<div class="voice-status" class:voice-status--pending={pending} role="group" aria-label={`Voice: ${roomName}`}>
		<div class="voice-status__text">
			<span class="voice-status__room"><span class="voice-status__dot" aria-hidden="true"></span><span class="voice-status__name">{roomName}</span></span>
			<span class="voice-status__line" role="status">{line}</span>
		</div>
		<Menu
			items={menuItems}
			label={optionsLabel}
			triggerLabel={optionsLabel}
			title={optionsLabel}
			heading={roomName}
			align="end"
			class="w-ibtn w-ibtn--sm voice-status__more"
		>
			<Icon name="more" />
		</Menu>
		<button type="button" class="w-ibtn w-ibtn--sm voice-status__leave" aria-label={leaveLabel} title={leaveLabel} on:click={handleLeave}>
			<Icon name="phoneOff" />
		</button>
	</div>
{/if}
