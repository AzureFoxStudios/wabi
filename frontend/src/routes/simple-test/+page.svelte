<script>
	// Immediate execution - no imports, no complexity
	console.log('SIMPLE TEST: JavaScript is executing');
	console.error('SIMPLE TEST: Error log (should show red)');
	console.warn('SIMPLE TEST: Warning log (should show yellow)');

	// Try to alert (will be blocked by some browsers but worth a shot)
	if (typeof window !== 'undefined') {
		window.addEventListener('load', () => {
			console.log('SIMPLE TEST: Window loaded');
		});
	}
</script>

<h1 style="color: lime; background: black; padding: 2rem; text-align: center;">
	✅ IF YOU SEE THIS, HTML IS LOADING
</h1>

<div style="background: #2a2a2a; color: white; padding: 2rem; max-width: 800px; margin: 2rem auto;">
	<h2>Simple Test Page</h2>
	<p>This page has NO complex imports, NO socket connections, NO Svelte stores.</p>
	<p>If you see this, the problem is NOT with the dev server.</p>

	<h3>Check your browser console:</h3>
	<ul>
		<li>You should see green "SIMPLE TEST" logs</li>
		<li>You should see a red error log</li>
		<li>You should see a yellow warning log</li>
	</ul>

	<h3>If you see ZERO console logs:</h3>
	<ul>
		<li>Check if console is filtered (look for a filter icon)</li>
		<li>Try different log levels (All, Verbose, Info, Warnings, Errors)</li>
		<li>Try Ctrl+Shift+J (or Cmd+Option+J on Mac) to reopen console</li>
		<li>Try a different browser</li>
	</ul>

	<div style="margin-top: 2rem;">
		<a href="/" style="color: #5865f2; font-size: 1.2rem;">← Back to Main App</a>
		<br>
		<a href="/test" style="color: #5865f2; font-size: 1.2rem;">→ Socket Diagnostic Page</a>
	</div>
</div>

<style>
	:global(body) {
		margin: 0;
		background: #1a1a1a;
		font-family: sans-serif;
	}
</style>
