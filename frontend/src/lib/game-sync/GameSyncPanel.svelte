<script lang="ts">
	/**
	 * Go in the companion panel (optional add-on `game-sync`, experimental). The frame's row A
	 * names the panel, its locality tag and Close; this body draws row B (the channel this board
	 * belongs to, plus the maturity word) because the manifest sets `ownsToolbar`.
	 *
	 * Rule application stays on the server (`core/crates/wabi-server/.../game_ops.rs`); this
	 * component only draws state and sends intents. Sessions are held in memory, so the frame says
	 * "Live only · not saved" rather than pretending the board survives a restart.
	 *
	 * Board: one hairline SVG grid, stones as ink-filled vs paper-hollow circles, and a transparent
	 * button per intersection for a roving tabindex (arrows / Home / End move, Enter or Space plays).
	 */
	import { onMount, onDestroy } from 'svelte';
	import { channels, currentChannel, currentUser, getSocket } from '$lib/socket';
	import type { GameIncoming, GameSessionState } from './protocol';
	import { GO_SIZES, STONE_LABEL } from './protocol';
	import {
		boardGridPaths,
		boardStarPoints,
		formatCoord,
		nextPointIndex,
		pointIndex
	} from './goBoard';
	import {
		JOIN_TIMEOUT_MS,
		boardMetaWords,
		channelOptions,
		errorWords,
		resultWords,
		scoreWords,
		turnWords,
		type PanelError
	} from './present';
	import { confirmAction } from '$lib/confirm';
	import Select from '$lib/components/ui/Select.svelte';
	import Segmented from '$lib/components/ui/Segmented.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import Notice from '$lib/components/ui/Notice.svelte';
	import LoadLine from '$lib/components/ui/LoadLine.svelte';
	import './game-sync.css';

	type Phase = 'joining' | 'ready' | 'failed';
	type BusyAction = 'create' | 'claim' | 'move' | 'pass' | 'resign' | null;

	const SIZE_OPTIONS = GO_SIZES.map((n) => ({ value: n, label: `${n}×${n}` }));
	const BUSY_TIMEOUT_MS = 8000;
	const uid = $props.id();

	let socket = $state<ReturnType<typeof getSocket>>(null);
	let phase = $state<Phase>('joining');
	let channelId = $state('');
	let pinned = $state(false);
	let session = $state<GameSessionState | null>(null);
	let noneState = $state(false);
	let error = $state<PanelError | null>(null);
	let busy = $state<BusyAction>(null);
	let size = $state<number>(19);
	let focusIndex = $state(0);
	let pointButtons: (HTMLButtonElement | undefined)[] = [];

	let joinTimer: ReturnType<typeof setTimeout> | null = null;
	let busyTimer: ReturnType<typeof setTimeout> | null = null;

	const me = $derived($currentUser);
	const options = $derived(channelOptions($channels));
	const channelLabel = $derived.by(() => {
		const channel = $channels.find((entry) => entry.id === channelId);
		if (!channel) return '';
		return channel.type === 'dm' || channel.type === 'group' ? channel.name : `#${channel.name}`;
	});
	const boardSize = $derived(session?.size ?? size);
	const boardCells = $derived(session?.board ?? []);
	const mySeat = $derived(
		session
			? session.seats[0] === me?.dbUserId
				? 0
				: session.seats[1] === me?.dbUserId
					? 1
					: -1
			: -1
	);
	const isPlayer = $derived(mySeat >= 0);
	const isMyTurn = $derived(session?.status === 'active' && session.toPlay === mySeat && mySeat >= 0);
	const canPlayPoint = $derived(isMyTurn && !busy);
	const canClaim = $derived(session?.status === 'waiting' && session.seats[1] === null && mySeat < 0);

	const lastPoint = $derived.by(() => {
		const move = session?.moves?.at(-1);
		if (!move || move.pass || move.x === undefined || move.y === undefined) return null;
		return { x: move.x, y: move.y };
	});
	const lastIndex = $derived(
		lastPoint && session ? pointIndex(session.size, lastPoint.x, lastPoint.y) : -1
	);
	const gridPath = $derived(boardGridPaths(boardSize));
	const starPointsForBoard = $derived(boardStarPoints(boardSize));

	const statusTitle = $derived.by(() => {
		if (!session) return '';
		if (session.status === 'waiting') return `Waiting for ${STONE_LABEL[1]}`;
		if (session.status === 'finished') return resultWords(session);
		return isMyTurn ? 'Your move' : turnWords(session.toPlay);
	});

	const statusText = $derived.by(() => {
		if (!session) return '';
		if (session.status === 'waiting') {
			return 'The white seat is open in this channel.';
		}
		if (session.status === 'finished') return scoreWords(session.score) ?? 'The board is closed.';
		if (isMyTurn) return 'Place a stone on an intersection, or pass.';
		if (!isPlayer) return 'You are watching this game.';
		return `Waiting for ${session.seatNames[1 - mySeat] ?? 'the other seat'}.`;
	});

	const pointLabels = $derived.by(() => {
		const n = boardSize;
		const ko = session?.ko ?? null;
		return boardCells.map((stone, index) => {
			const x = index % n;
			const y = Math.floor(index / n);
			const parts = [formatCoord(x, y)];
			parts.push(stone === 0 ? 'black stone' : stone === 1 ? 'white stone' : 'empty');
			if (index === lastIndex) parts.push('last move');
			if (ko && ko.x === x && ko.y === y) parts.push('ko point');
			return parts.join(', ');
		});
	});

	// One tab stop: the centre of a new board. Arrow keys move it; the point under it plays.
	$effect(() => {
		const n = boardSize;
		focusIndex = pointIndex(n, Math.floor(n / 2), Math.floor(n / 2));
	});

	function ensureSocket(): ReturnType<typeof getSocket> {
		if (socket) return socket;
		const next = getSocket();
		if (!next) return null;
		socket = next;
		next.on('game:state', onState);
		next.on('game:error', onError);
		return next;
	}

	function emit(name: string, payload: Record<string, unknown> = {}, onChannel = channelId): boolean {
		const sock = ensureSocket();
		if (!sock || !onChannel) return false;
		sock.emit(name, { channelId: onChannel, ...payload });
		return true;
	}

	function clearJoinTimer(): void {
		if (joinTimer) clearTimeout(joinTimer);
		joinTimer = null;
	}

	function clearBusy(): void {
		if (busyTimer) clearTimeout(busyTimer);
		busyTimer = null;
		busy = null;
	}

	function startBusy(action: Exclude<BusyAction, null>): void {
		if (busy) return;
		busy = action;
		error = null;
		if (busyTimer) clearTimeout(busyTimer);
		busyTimer = setTimeout(() => {
			if (!busy) return;
			clearBusy();
			error = errorWords('timeout');
		}, BUSY_TIMEOUT_MS);
	}

	function run(action: Exclude<BusyAction, null>, name: string, payload: Record<string, unknown> = {}): void {
		if (busy || !channelId) return;
		startBusy(action);
		if (!emit(name, payload)) {
			clearBusy();
			error = errorWords('timeout');
		}
	}

	function join(id: string): void {
		if (!id) return;
		clearJoinTimer();
		clearBusy();
		channelId = id;
		session = null;
		noneState = false;
		error = null;
		phase = 'joining';
		joinTimer = setTimeout(() => {
			if (phase !== 'joining' || channelId !== id) return;
			phase = 'failed';
			error = errorWords('timeout');
		}, JOIN_TIMEOUT_MS);
		emit('game:join', {}, id);
	}

	function onState(next: GameIncoming): void {
		if (!next || next.channelId !== channelId) return;
		clearJoinTimer();
		clearBusy();
		error = null;
		phase = 'ready';
		if (next.status === 'none') {
			session = null;
			noneState = true;
			return;
		}
		session = next;
		noneState = false;
	}

	function onError(payload: { error?: string; channelId?: string }): void {
		// Access errors name their channel; never fail this panel for another board's refusal.
		if (payload?.channelId && payload.channelId !== channelId) return;
		const words = errorWords(payload?.error);
		clearBusy();
		if (phase === 'joining') {
			clearJoinTimer();
			phase = 'failed';
			error = words;
			return;
		}
		error = words;
	}

	function syncChannel(): void {
		const list = $channels;
		if (pinned && channelId && list.some((channel) => channel.id === channelId)) return;
		const preferred = list.find((channel) => channel.id === $currentChannel)?.id ?? '';
		const next = preferred || list[0]?.id || '';
		if (!next) {
			clearJoinTimer();
			channelId = '';
			session = null;
			noneState = false;
			error = null;
			phase = 'ready';
			return;
		}
		if (next === channelId) return;
		join(next);
	}

	function selectChannel(next: string): void {
		if (next === channelId) return;
		pinned = true;
		join(next);
	}

	function retryJoin(): void {
		if (channelId) join(channelId);
		else syncChannel();
	}

	function createGame(): void {
		run('create', 'game:create', { size });
	}

	function restart(): void {
		if (session) size = session.size;
		createGame();
	}

	function claimSeat(): void {
		run('claim', 'game:claim');
	}

	function playPoint(x: number, y: number, stone: number): void {
		if (!canPlayPoint || stone !== -1) return;
		run('move', 'game:move', { x, y });
	}

	function pass(): void {
		if (!isMyTurn || busy) return;
		run('pass', 'game:pass');
	}

	async function resign(): Promise<void> {
		if (!isPlayer || session?.status !== 'active' || busy) return;
		const other = session.seatNames[1 - mySeat] ?? 'The other seat';
		const confirmed = await confirmAction({
			title: 'Resign this game?',
			body: `${other} wins by resignation. The board stays until someone starts a new game.`,
			confirm: 'Resign game',
			danger: true
		});
		if (!confirmed) return;
		run('resign', 'game:resign');
	}

	function moveFocus(event: KeyboardEvent, index: number, board: number): void {
		const next = nextPointIndex(board, index, event.key);
		if (next === null) return;
		event.preventDefault();
		focusIndex = next;
		pointButtons[next]?.focus();
	}

	onMount(() => {
		syncChannel();
		const unsubChannels = channels.subscribe(() => syncChannel());
		const unsubCurrent = currentChannel.subscribe(() => syncChannel());
		return () => {
			unsubChannels();
			unsubCurrent();
		};
	});

	onDestroy(() => {
		clearJoinTimer();
		clearBusy();
		if (socket) {
			socket.off('game:state', onState);
			socket.off('game:error', onError);
		}
	});
</script>

{#snippet startActions()}
	<div class="go-start">
		<div class="go-start__row">
			<span class="go-start__label" id={`${uid}-go-size`}>Board size</span>
			<Segmented labelledby={`${uid}-go-size`} options={SIZE_OPTIONS} bind:value={size} />
		</div>
		<button
			type="button"
			class="w-btn w-btn--primary"
			onclick={createGame}
			disabled={!!busy || !channelId}
			aria-busy={busy === 'create'}
		>
			Start a game
		</button>
	</div>
{/snippet}

<div class="game-sync">
	<!-- Row B: the channel this board belongs to; the add-on's maturity word sits at its end. -->
	<div class="w-panel__b go-bar">
		<Select
			class="go-bar__select"
			ariaLabel="Channel"
			options={options}
			value={channelId}
			placeholder="Choose a channel"
			disabled={options.length === 0}
			onchange={selectChannel}
		/>
		<span class="w-tag w-tag--mat" title="Experimental: not a production guarantee">
			Experimental
		</span>
		<LoadLine active={phase === 'joining'} label="Loading this channel's game" class="go-loadline" delay={120} />
	</div>

	<div class="go-panel">
		{#if phase === 'joining'}
			<div class="go-loading" aria-hidden="true">
				<span class="w-skel go-loading__title"></span>
				<span class="w-skel go-loading__board"></span>
				<span class="w-skel"></span>
				<span class="w-skel go-loading__short"></span>
			</div>
			<p class="sr-only" role="status">Loading this channel's game</p>
		{:else if phase === 'failed'}
			{@const failed = error ?? errorWords('timeout')}
			<Notice title={failed.title} text={failed.text} error={failed.raw} onretry={retryJoin} retryLabel="Retry" />
		{:else if options.length === 0}
			<EmptyState
				icon="gamepad"
				as="p"
				title="No channels yet"
				text="Join a channel, then choose it here to start a board."
			/>
		{:else if noneState}
			{#if error}
				<Notice class="go-notice" title={error.title} text={error.text} error={error.raw} ondismiss={() => (error = null)} />
			{/if}
			<EmptyState
				icon="gamepad"
				as="p"
				title={channelLabel ? `No game in ${channelLabel}` : 'No game in this channel'}
				text="Start a board; the second seat is open for someone here to claim."
				actions={startActions}
			/>
		{:else if session}
			{#if error}
				<Notice class="go-notice" title={error.title} text={error.text} error={error.raw} ondismiss={() => (error = null)} />
			{/if}

			<div class="go-status" aria-live="polite">
				<p class="go-status__title">{statusTitle}</p>
				<p class="go-status__text">{statusText}</p>
			</div>

			<div class="go-seats">
				<span class="go-seat" class:go-seat--turn={session.status === 'active' && session.toPlay === 0}>
					<span class="go-seat__stone" aria-hidden="true"></span>
					<span class="go-seat__label">Black</span>
					<span class="go-seat__name">{session.seatNames[0] ?? 'Open seat'}</span>
				</span>
				<span class="go-seat" class:go-seat--turn={session.status === 'active' && session.toPlay === 1}>
					<span class="go-seat__stone go-seat__stone--paper" aria-hidden="true"></span>
					<span class="go-seat__label">White</span>
					<span class="go-seat__name">{session.seatNames[1] ?? 'Open seat'}</span>
				</span>
			</div>

			<div class="go-board" style={`--go-n:${boardSize}`}>
				<div class="go-board__field">
					<svg class="go-board__grid" viewBox={`0 0 ${boardSize} ${boardSize}`} aria-hidden="true">
						<path class="go-board__lines" d={gridPath} />
						{#each starPointsForBoard as star, index (index)}
							<circle class="go-board__star" cx={star.x} cy={star.y} r="0.085" />
						{/each}
						{#each boardCells as stone, index (index)}
							{#if stone === 0 || stone === 1}
								{@const x = index % boardSize}
								{@const y = Math.floor(index / boardSize)}
								<circle
									class="go-board__stone"
									class:go-board__stone--paper={stone === 1}
									cx={x + 0.5}
									cy={y + 0.5}
									r="0.46"
								/>
							{/if}
						{/each}
						{#if session.ko}
							<circle class="go-board__ko" cx={session.ko.x + 0.5} cy={session.ko.y + 0.5} r="0.2" />
						{/if}
						{#if lastPoint}
							<circle class="go-board__last" cx={lastPoint.x + 0.5} cy={lastPoint.y + 0.5} r="0.13" />
						{/if}
					</svg>
					<div
						class="go-board__points"
						role="group"
						aria-label={`Go board, ${boardSize} by ${boardSize}.${canPlayPoint ? ' Use arrow keys to move, Enter or Space to play.' : ''}`}
					>
						{#each boardCells as stone, index (index)}
							{@const x = index % boardSize}
							{@const y = Math.floor(index / boardSize)}
							<button
								bind:this={pointButtons[index]}
								type="button"
								class="go-point"
								class:go-point--play={canPlayPoint && stone === -1}
								tabindex={index === focusIndex ? 0 : -1}
								aria-label={pointLabels[index]}
								aria-disabled={!canPlayPoint || stone !== -1}
								onclick={() => playPoint(x, y, stone)}
								onkeydown={(event) => moveFocus(event, index, boardSize)}
							></button>
						{/each}
					</div>
				</div>
			</div>

			<p class="go-meta">{boardMetaWords(boardSize, session.moves.length)}</p>

			<div class="go-actions">
				{#if session.status === 'waiting'}
					{#if canClaim}
						<button
							type="button"
							class="w-btn w-btn--primary"
							onclick={claimSeat}
							disabled={!!busy}
							aria-busy={busy === 'claim'}
						>
							Join as White
						</button>
					{:else}
						<p class="go-hint">This board stays here while the white seat is open.</p>
					{/if}
				{:else if session.status === 'active'}
					{#if isPlayer}
						<button
							type="button"
							class="w-btn w-btn--sm"
							onclick={pass}
							disabled={!isMyTurn || !!busy}
							aria-busy={busy === 'pass'}
						>
							Pass
						</button>
						<button
							type="button"
							class="w-btn w-btn--danger w-btn--sm"
							onclick={resign}
							disabled={!!busy}
							aria-busy={busy === 'resign'}
						>
							Resign
						</button>
					{:else}
						<p class="go-hint">Two seats, one board. You are watching this one.</p>
					{/if}
				{:else}
					<button
						type="button"
						class="w-btn w-btn--primary w-btn--sm"
						onclick={restart}
						disabled={!!busy}
						aria-busy={busy === 'create'}
					>
						New game
					</button>
				{/if}
			</div>
		{/if}
	</div>
</div>
