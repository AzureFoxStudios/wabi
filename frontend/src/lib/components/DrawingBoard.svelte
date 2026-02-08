<script lang="ts">
	// EXCALIDRAW FEATURE DISABLED - React/Excalidraw dependencies removed
	// To re-enable: npm install react react-dom @excalidraw/excalidraw

	// import { onMount, onDestroy, tick } from 'svelte';
	// import { socket } from '$lib/socket';
	// import { browser } from '$app/environment';

	// let excalidrawContainer: HTMLDivElement;
	// let excalidrawAPI: any = null;
	// let isLoading = true;
	// let errorMessage = '';

	// onMount(async () => {
	// 	if (!browser) return;

	// 	try {
	// 		// First, hide the loading state to render the container
	// 		isLoading = false;

	// 		// Wait for Svelte to update the DOM
	// 		await tick();

	// 		// Now the container should be available
	// 		if (!excalidrawContainer) {
	// 			throw new Error('Excalidraw container not found after DOM update');
	// 		}

	// 		// Import React first and set it globally (required for Excalidraw)
	// 		const React = await import('react');
	// 		const ReactDOM = await import('react-dom/client');

	// 		// Set React globally before importing Excalidraw
	// 		(window as any).React = React;

	// 		// Now import Excalidraw
	// 		const { Excalidraw } = await import('@excalidraw/excalidraw');

	// 		console.log('Excalidraw and React loaded successfully');

	// 		// Create React root and render Excalidraw
	// 		const root = ReactDOM.createRoot(excalidrawContainer);

	// 		root.render(
	// 			React.createElement(Excalidraw, {
	// 				onChange: (elements: any, appState: any) => {
	// 					throttledChange(elements, appState);
	// 				},
	// 				excalidrawAPI: (api: any) => {
	// 					handleExcalidrawAPI(api);
	// 				}
	// 			})
	// 		);

	// 		// Set up collaboration
	// 		if ($socket) {
	// 			$socket.on('excalidraw-update', (state: any) => {
	// 				if (excalidrawAPI && state) {
	// 					try {
	// 						excalidrawAPI.updateScene(state);
	// 					} catch (error) {
	// 						console.error('Error updating scene:', error);
	// 					}
	// 				}
	// 			});

	// 			$socket.on('init', (data: any) => {
	// 				if (excalidrawAPI && data.excalidrawState) {
	// 					try {
	// 						excalidrawAPI.updateScene(data.excalidrawState);
	// 					} catch (error) {
	// 						console.error('Error updating scene from init:', error);
	// 					}
	// 				}
	// 			});
	// 		}
	// 	} catch (error) {
	// 		console.error('Failed to load Excalidraw:', error);
	// 		errorMessage = error instanceof Error ? error.message : 'Unknown error';
	// 	}
	// });

	// onDestroy(() => {
	// 	if ($socket) {
	// 		$socket.off('excalidraw-update');
	// 	}
	// });

	// function handleChange(elements: any, appState: any) {
	// 	if (!$socket || !elements) return;

	// 	// Broadcast changes to other users (throttled)
	// 	const state = {
	// 		elements,
	// 		appState: {
	// 			viewBackgroundColor: appState.viewBackgroundColor
	// 		}
	// 	};

	// 	$socket.emit('excalidraw-update', state);
	// }

	// let changeTimeout: number;
	// function throttledChange(elements: any, appState: any) {
	// 	if (changeTimeout) {
	// 		clearTimeout(changeTimeout);
	// 	}

	// 	changeTimeout = setTimeout(() => {
	// 		handleChange(elements, appState);
	// 	}, 500) as unknown as number;
	// }

	// function handleExcalidrawAPI(api: any) {
	// 	excalidrawAPI = api;
	// 	console.log('Excalidraw API initialized:', api);
	// }
</script>

<div class="drawing-container">
	<div class="header">
		<h2>✏️ Collaborative Drawing</h2>
	</div>

	<div class="disabled-message">
		<p>Drawing feature is currently disabled.</p>
		<p class="hint">This feature required React and Excalidraw dependencies which have been removed to simplify the project.</p>
	</div>
</div>

<style>
	.drawing-container {
		height: 100vh;
		height: 100dvh;
		display: flex;
		flex-direction: column;
		background: var(--bg-primary);
	}

	.header {
		padding: 1rem;
		background: var(--bg-secondary);
		border-bottom: 1px solid var(--border);
	}

	.header h2 {
		font-size: 1.25rem;
	}

	.excalidraw-wrapper {
		flex: 1;
		overflow: hidden;
	}

	.disabled-message {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		color: var(--text-secondary);
		font-size: 1.1rem;
		text-align: center;
		padding: 2rem;
	}

	.disabled-message p {
		margin: 0.5rem 0;
	}

	.disabled-message .hint {
		font-size: 0.9rem;
		opacity: 0.7;
		max-width: 500px;
	}

	:global(.excalidraw) {
		height: 100% !important;
	}

	:global(.excalidraw .App-menu_top) {
		background: var(--bg-secondary) !important;
	}
</style>
