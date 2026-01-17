<script lang="ts">
	import { createEventDispatcher } from 'svelte';

	export let currentGraph: 'workspace' | 'personal' = 'workspace';

	const dispatch = createEventDispatcher();

	let showNewWorkspaceDialog = false;
	let newWorkspaceName = '';
	let newWorkspaceMethod = 'blank';

	function switchGraph(type: 'workspace' | 'personal') {
		currentGraph = type;
		dispatch('graph-change', { type });
	}

	function openNewWorkspaceDialog() {
		showNewWorkspaceDialog = true;
		newWorkspaceName = '';
		newWorkspaceMethod = 'blank';
	}

	function closeNewWorkspaceDialog() {
		showNewWorkspaceDialog = false;
		newWorkspaceName = '';
		newWorkspaceMethod = 'blank';
	}

	function createNewWorkspace() {
		if (!newWorkspaceName.trim()) {
			alert('Please enter a workspace name');
			return;
		}

		// Dispatch event to parent to create new workspace
		dispatch('create-workspace', {
			name: newWorkspaceName.trim(),
			method: newWorkspaceMethod
		});

		closeNewWorkspaceDialog();
	}
</script>

<div class="graph-switcher-container">
	<div class="graph-switcher">
		<button
			class="tab-btn {currentGraph === 'workspace' ? 'active' : ''}"
			on:click={() => switchGraph('workspace')}>
			🏢 Workspace
		</button>
		<button
			class="tab-btn {currentGraph === 'personal' ? 'active' : ''}"
			on:click={() => switchGraph('personal')}>
			👤 Personal
		</button>
		<button class="new-tab-btn" on:click={openNewWorkspaceDialog} title="Create new workspace">
			➕
		</button>
	</div>

	<!-- New Workspace Dialog -->
	{#if showNewWorkspaceDialog}
		<div
			class="dialog-overlay"
			role="button"
			tabindex="0"
			on:click={closeNewWorkspaceDialog}
			on:keydown={(event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					closeNewWorkspaceDialog();
				}
			}}
		>
			<div
				class="dialog-box"
				role="button"
				tabindex="0"
				on:click|stopPropagation
				on:keydown|stopPropagation={(event) => {
					if (event.key === 'Enter' || event.key === ' ') {
						event.preventDefault();
					}
				}}
			>
				<h2>Create New Workspace</h2>

				<div class="form-group">
					<label for="workspace-name">Workspace Name</label>
					<input
						id="workspace-name"
						type="text"
						placeholder="e.g., Project Alpha"
						bind:value={newWorkspaceName}
						on:keydown={(e) => e.key === 'Enter' && createNewWorkspace()}
					/>
				</div>

				<div class="form-group">
					<label>How do you want to build this?</label>
					<div class="method-options">
						<button
							class="method-btn {newWorkspaceMethod === 'blank' ? 'selected' : ''}"
							on:click={() => newWorkspaceMethod = 'blank'}
						>
							<div class="method-icon">📄</div>
							<div class="method-name">Start Blank</div>
							<div class="method-desc">Empty canvas</div>
						</button>
						<button
							class="method-btn {newWorkspaceMethod === 'template' ? 'selected' : ''}"
							on:click={() => newWorkspaceMethod = 'template'}
						>
							<div class="method-icon">📋</div>
							<div class="method-name">From Template</div>
							<div class="method-desc">Use a template</div>
						</button>
						<button
							class="method-btn {newWorkspaceMethod === 'import' ? 'selected' : ''}"
							on:click={() => newWorkspaceMethod = 'import'}
						>
							<div class="method-icon">📤</div>
							<div class="method-name">Import</div>
							<div class="method-desc">Import data</div>
						</button>
					</div>
				</div>

				<div class="dialog-actions">
					<button class="btn-cancel" on:click={closeNewWorkspaceDialog}>Cancel</button>
					<button class="btn-create" on:click={createNewWorkspace}>Create</button>
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.graph-switcher-container {
		position: relative;
	}

	.graph-switcher {
		display: flex;
		gap: 0;
		background: #2a2a2e;
		border-radius: 8px;
		padding: 4px;
		width: fit-content;
		border: 1px solid #444;
	}

	.tab-btn {
		padding: 10px 16px;
		background: transparent;
		border: none;
		border-radius: 6px;
		color: #a0a0a0;
		cursor: pointer;
		transition: all 0.2s;
		font-size: 14px;
		font-weight: 500;
		white-space: nowrap;
	}

	.tab-btn:hover {
		color: #e0e0e0;
		background: rgba(99, 102, 241, 0.1);
	}

	.tab-btn.active {
		background: linear-gradient(135deg, #6366f1 0%, #7c3aed 100%);
		color: white;
		font-weight: 600;
		box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
	}

	.new-tab-btn {
		padding: 10px 12px;
		background: transparent;
		border: none;
		border-radius: 6px;
		color: #a0a0a0;
		cursor: pointer;
		font-size: 16px;
		transition: all 0.2s;
		margin-left: 4px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.new-tab-btn:hover {
		background: rgba(16, 185, 129, 0.1);
		color: #10b981;
	}

	/* Dialog Styles */
	.dialog-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.7);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 2000;
		backdrop-filter: blur(5px);
	}

	.dialog-box {
		background: #1e1e24;
		border: 2px solid rgba(99, 102, 241, 0.3);
		border-radius: 12px;
		padding: 32px;
		max-width: 400px;
		width: 90%;
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
	}

	.dialog-box h2 {
		margin: 0 0 24px 0;
		font-size: 1.5rem;
		background: linear-gradient(135deg, #6366f1 0%, #a78bfa 100%);
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
	}

	.form-group {
		margin-bottom: 20px;
	}

	.form-group label {
		display: block;
		margin-bottom: 8px;
		font-weight: 600;
		color: #e0e0e0;
		font-size: 0.9rem;
	}

	.form-group input {
		width: 100%;
		padding: 12px;
		background: rgba(99, 102, 241, 0.05);
		border: 2px solid rgba(99, 102, 241, 0.2);
		border-radius: 8px;
		color: #e0e0e0;
		font-size: 0.95rem;
		font-family: inherit;
		box-sizing: border-box;
		transition: all 0.2s;
	}

	.form-group input:focus {
		outline: none;
		border-color: #6366f1;
		background: rgba(99, 102, 241, 0.1);
		box-shadow: 0 0 20px rgba(99, 102, 241, 0.3);
	}

	.method-options {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 12px;
	}

	.method-btn {
		padding: 16px;
		background: rgba(99, 102, 241, 0.05);
		border: 2px solid rgba(99, 102, 241, 0.2);
		border-radius: 8px;
		cursor: pointer;
		transition: all 0.2s;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		text-align: center;
	}

	.method-btn:hover {
		border-color: #6366f1;
		background: rgba(99, 102, 241, 0.1);
	}

	.method-btn.selected {
		background: linear-gradient(135deg, rgba(99, 102, 241, 0.2) 0%, rgba(124, 58, 237, 0.2) 100%);
		border-color: #6366f1;
		box-shadow: 0 0 12px rgba(99, 102, 241, 0.3);
	}

	.method-icon {
		font-size: 1.8rem;
	}

	.method-name {
		font-weight: 600;
		color: #e0e0e0;
		font-size: 0.9rem;
	}

	.method-desc {
		font-size: 0.75rem;
		color: #808080;
	}

	.dialog-actions {
		display: flex;
		gap: 12px;
		margin-top: 24px;
	}

	.btn-cancel,
	.btn-create {
		flex: 1;
		padding: 12px 16px;
		border: none;
		border-radius: 8px;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.2s;
	}

	.btn-cancel {
		background: rgba(239, 68, 68, 0.1);
		color: #ef4444;
		border: 1px solid rgba(239, 68, 68, 0.3);
	}

	.btn-cancel:hover {
		background: rgba(239, 68, 68, 0.2);
	}

	.btn-create {
		background: linear-gradient(135deg, #10b981 0%, #059669 100%);
		color: white;
		box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
	}

	.btn-create:hover {
		box-shadow: 0 6px 16px rgba(16, 185, 129, 0.4);
		transform: translateY(-2px);
	}
</style>
