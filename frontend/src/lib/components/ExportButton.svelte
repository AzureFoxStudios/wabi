<script lang="ts">
	import { channelMessages, currentChannel, users } from '$lib/socket';

	function exportData() {
		const data = {
			exportDate: new Date().toISOString(),
			currentChannel: $currentChannel,
			messages: $channelMessages[$currentChannel] || [],
			users: $users
		};

		const blob = new Blob([JSON.stringify(data, null, 2)], {
			type: 'application/json'
		});

		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `chat-export-${$currentChannel}-${Date.now()}.json`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	}
</script>

<button on:click={exportData} class="export-btn" title="Export chat history">
	📥 Export
</button>

<style>
	.export-btn {
		background: var(--bg-tertiary);
		font-size: 0.85rem;
	}

	.export-btn:hover {
		background: var(--border);
	}
</style>
