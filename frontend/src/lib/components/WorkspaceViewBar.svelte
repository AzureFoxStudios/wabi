<script lang="ts">
	let {
		activeView,
		onSelectView,
		showReturnToMessages = true
	}: {
		activeView: string;
		onSelectView: (view: string) => void;
		showReturnToMessages?: boolean;
	} = $props();

	// The pill reveal is JS-driven, not :hover — :hover sticks permanently
	// when the pointer leaves the OS window while over the bar (alt-tab,
	// second monitor) or after touch taps on hybrid screens, pinning the bar
	// extended. chat-header.css reveals pills off the `.extended` class.
	let extended = $state(false);
	let actionsEl: HTMLDivElement | undefined = $state();

	function extend(event: PointerEvent): void {
		if (event.pointerType === 'mouse') extended = true;
	}
	function collapse(): void {
		extended = false;
	}

	// A press outside the bar collapses it — clears touch-emulated sticky
	// hover and any reveal left behind by a lost pointer.
	$effect(() => {
		const onDocPointerDown = (event: PointerEvent): void => {
			if (!actionsEl?.contains(event.target as Node)) collapse();
		};
		document.addEventListener('pointerdown', onDocPointerDown);
		return () => document.removeEventListener('pointerdown', onDocPointerDown);
	});

	// Mouse clicks leave the clicked button focused, which keeps the bar in
	// :focus-within and pins every pill open (the compaction never re-engages).
	// Blur on selection so the pills collapse again; keyboard Tab navigation
	// still reveals them via :focus-within as intended.
	function handleSelect(view: string, event: Event): void {
		(event.currentTarget as HTMLElement | null)?.blur();
		onSelectView(view);
	}
</script>

<svelte:window onblur={collapse} />

<div class="workspace-view-bar">
	{#if showReturnToMessages && activeView !== 'messages'}
		<button
			class="surface-return-btn btn-secondary"
			type="button"
			onclick={(e) => handleSelect('messages', e)}
			title="Return to messages"
			aria-label="Return to messages"
		>
			Messages
		</button>
	{/if}
	<div
		class="workspace-view-actions"
		class:compactable={true}
		class:extended
		bind:this={actionsEl}
		role="tablist"
		aria-label="Channel views"
		onpointerenter={extend}
		onpointerleave={collapse}
		onpointercancel={collapse}
	>
		<button
			class="view-open-btn"
			class:active={activeView === 'voice'}
			type="button"
			onclick={(e) => handleSelect('voice', e)}
			title="Voice view — all calls"
			aria-label="Open voice view"
		>
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M3 18v-6a9 9 0 0 1 18 0v6"></path>
				<path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"></path>
			</svg>
		</button>
		<button
			class="view-open-btn"
			class:active={activeView === 'messages'}
			type="button"
			onclick={(e) => handleSelect('messages', e)}
			title="Show messages"
			aria-label="Show messages"
		>
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
			</svg>
		</button>
		<button
			class="view-open-btn"
			class:active={activeView === 'whiteboard'}
			type="button"
			onclick={(e) => handleSelect('whiteboard', e)}
			title="Show whiteboard"
			aria-label="Show whiteboard"
		>
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<rect x="3" y="4" width="18" height="14" rx="2"></rect>
				<path d="M7 8h10"></path>
				<path d="M7 12h6"></path>
				<path d="M8 20h8"></path>
			</svg>
		</button>
		<button
			class="view-open-btn"
			class:active={activeView === 'planner'}
			type="button"
			onclick={(e) => handleSelect('planner', e)}
			title="Open Planner"
			aria-label="Open Planner"
		>
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<rect x="3" y="3" width="18" height="18" rx="2"></rect>
				<path d="M3 9h18"></path>
				<path d="M9 21V9"></path>
			</svg>
		</button>
		<button
			class="view-open-btn"
			class:active={activeView === 'notes'}
			type="button"
			onclick={(e) => handleSelect('notes', e)}
			title="Open Notes"
			aria-label="Open Notes"
		>
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
				<polyline points="14 2 14 8 20 8"></polyline>
				<line x1="16" y1="13" x2="8" y2="13"></line>
				<line x1="16" y1="17" x2="8" y2="17"></line>
			</svg>
		</button>
		<button
			class="view-open-btn"
			class:active={activeView === 'lore'}
			type="button"
			onclick={(e) => handleSelect('lore', e)}
			title="Open Project (Lore repositories)"
			aria-label="Open Project (Lore repositories)"
		>
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<polyline points="16 18 22 12 16 6"></polyline>
				<polyline points="8 6 2 12 8 18"></polyline>
			</svg>
		</button>
		<button
			class="view-open-btn"
			class:active={activeView === 'files'}
			type="button"
			onclick={(e) => handleSelect('files', e)}
			title="Open Files workspace"
			aria-label="Open Files workspace"
		>
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
			</svg>
		</button>
		<button
			class="view-open-btn"
			class:active={activeView === 'media'}
			type="button"
			onclick={(e) => handleSelect('media', e)}
			title="Open media albums view"
			aria-label="Open media albums view"
		>
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<rect x="3" y="3" width="18" height="18" rx="2"></rect>
				<circle cx="8.5" cy="8.5" r="1.5"></circle>
				<polyline points="21 15 16 10 5 21"></polyline>
			</svg>
		</button>
		<button
			class="view-open-btn"
			class:active={activeView === 'reader'}
			type="button"
			onclick={(e) => handleSelect('reader', e)}
			title="Open reader view"
			aria-label="Open reader view"
		>
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
				<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
			</svg>
		</button>
		<button
			class="view-open-btn"
			class:active={activeView === 'model'}
			type="button"
			onclick={(e) => handleSelect('model', e)}
			title="Open 3D view"
			aria-label="Open 3D view"
		>
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
				<path d="M3.27 6.96 12 12.01l8.73-5.05"></path>
				<path d="M12 22.08V12"></path>
			</svg>
		</button>
		<button
			class="view-open-btn"
			class:active={activeView === 'map'}
			type="button"
			onclick={(e) => handleSelect('map', e)}
			title="Open map view"
			aria-label="Open map view"
		>
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"></path>
				<path d="M9 4v14"></path>
				<path d="M15 6v14"></path>
			</svg>
		</button>
	</div>
</div>
