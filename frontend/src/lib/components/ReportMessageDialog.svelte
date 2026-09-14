<script lang="ts">
	import type { Message } from '$lib/socket';
	import { activeServerUrl } from '$lib/serverUrl';
	import { currentChannel } from '$lib/channelStore';
	import { getAuthToken } from '$lib/authSession';

	export let visible = false;
	export let message: Message | null = null;
	export let onClose: () => void = () => {};

	let reason = 'Server rule violation';
	let comment = '';
	let busy = false;
	let error = '';
	let sent = false;
	const reasons = ['Spam', 'Harassment', 'Hate / abusive behavior', 'Sexual content', 'Threats / dangerous behavior', 'Server rule violation', 'Something else'];

	$: if (!visible) { error = ''; sent = false; comment = ''; reason = 'Server rule violation'; }

	async function submit() {
		if (!message || busy) return;
		busy = true; error = '';
		try {
			const token = getAuthToken($activeServerUrl);
			if (!token) throw new Error('Sign in again before reporting a message.');
			const response = await fetch(`${$activeServerUrl}/api/server-center/reports`, {
				method: 'POST', credentials: 'include', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ channelId: $currentChannel, messageId: message.id, reason, comment: comment.trim() || null })
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(data.error || `Could not submit report (${response.status}).`);
			sent = true;
		} catch (cause) { error = cause instanceof Error ? cause.message : 'Could not submit report.'; }
		finally { busy = false; }
	}
</script>

{#if visible && message}
	<div class="backdrop" role="presentation" onclick={(event) => { if (event.currentTarget === event.target) onClose(); }}>
		<section class="dialog" role="dialog" aria-modal="true" aria-labelledby="report-title">
			{#if sent}
				<div class="success"><span class="mark">✓</span><h2 id="report-title">Report sent</h2><p>Server staff can review the evidence snapshot and your note. Your report does not automatically punish anyone.</p><button onclick={onClose}>Done</button></div>
			{:else}
				<header><div><span>Report to this server</span><h2 id="report-title">Report message</h2></div><button class="close" aria-label="Close" onclick={onClose}>×</button></header>
				<div class="snapshot"><strong>@{message.user}</strong><p>{message.text || 'This message has no text.'}</p></div>
				<label><span>What is wrong?</span><select bind:value={reason}>{#each reasons as item}<option>{item}</option>{/each}</select></label>
				<label><span>Anything staff should know? <small>Optional</small></span><textarea bind:value={comment} maxlength="1000" rows="4" placeholder="Add context without having to copy/paste the message…"></textarea></label>
				<div class="evidence"><strong>This report preserves evidence.</strong><span>Even if this channel is ephemeral or the message is later deleted, submitting the report stores this message snapshot in the server’s moderation case so staff can review what you chose to report.</span></div>
				<p class="privacy">The evidence goes only to this server’s staff. Wabi does not send the report to a central Wabi moderation service. Cancel if you do not want to disclose this message to staff.</p>
				{#if error}<div class="error" role="alert">{error}</div>{/if}
				<footer><button class="cancel" onclick={onClose}>Cancel</button><button class="submit" onclick={submit} disabled={busy}>{busy ? 'Sending…' : 'Preserve & send report'}</button></footer>
			{/if}
		</section>
	</div>
{/if}

<style>
	.backdrop{position:fixed;inset:0;z-index:10020;display:grid;place-items:center;padding:18px;background:rgba(0,0,0,.52);backdrop-filter:blur(5px)}.dialog{width:min(520px,100%);max-height:min(760px,calc(100vh - 36px));overflow:auto;padding:20px;border:1px solid var(--border-default);border-radius:18px;background:var(--surface-raised);box-shadow:0 24px 80px rgba(0,0,0,.35);display:grid;gap:15px}.dialog header{display:flex;justify-content:space-between;align-items:start}.dialog header span{font-size:.75rem;text-transform:uppercase;letter-spacing:.09em;color:var(--text-muted)}h2{margin:3px 0 0}.close{font-size:1.5rem;line-height:1;width:36px;height:36px;padding:0}.snapshot{padding:13px 14px;background:var(--surface-base);border:1px solid var(--border-default);border-radius:11px}.snapshot p{margin:5px 0 0;white-space:pre-wrap;max-height:130px;overflow:auto;color:var(--text-secondary)}label{display:grid;gap:6px}label>span{font-size:.84rem;font-weight:600}small{color:var(--text-muted);font-weight:400}select,textarea{width:100%;box-sizing:border-box;font:inherit;color:var(--text-primary);background:var(--surface-base);border:1px solid var(--border-default);border-radius:10px;padding:10px}textarea{resize:vertical}.evidence{display:grid;gap:4px;padding:11px 12px;border:1px solid var(--border-default);border-radius:10px;background:var(--surface-base)}.evidence span,.privacy{color:var(--text-secondary);font-size:.82rem;line-height:1.4}.privacy{margin:0}.error{padding:10px 12px;border:1px solid var(--danger);border-radius:9px}footer{display:flex;justify-content:flex-end;gap:8px}button{font:inherit;cursor:pointer;color:var(--text-primary);background:var(--surface-base);border:1px solid var(--border-default);border-radius:9px;padding:9px 13px}.submit{font-weight:650}.success{text-align:center;padding:14px 4px;display:grid;justify-items:center;gap:9px}.success h2,.success p{margin:0}.success p{color:var(--text-secondary);max-width:390px}.mark{display:grid;place-items:center;width:48px;height:48px;border-radius:50%;border:1px solid var(--border-default);font-size:1.4rem}
</style>
