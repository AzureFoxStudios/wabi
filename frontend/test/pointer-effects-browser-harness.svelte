<script lang="ts">
	import PointerEffectsTab from '../src/lib/effects/PointerEffectsTab.svelte';
	let clicks = $state(0);
</script>

<main>
	<aside aria-label="Appearance settings">
		<header><span>APPEARANCE</span><h1>A little world under Wabi</h1><p>Production pointer controls · isolated browser verification</p></header>
		<PointerEffectsTab />
	</aside>
	<section id="pointer-stage" aria-label="Pointer test workspace">
		<div class="stage-intro"><span>WABI / CREATIVE ROOM</span><h2>Move. Discover. Settle.</h2><p>Scattered objects and connected worlds live alongside your conversations.</p></div>
		<div class="message"><b>Rin</b><time>Today, 09:42</time><p>Little details make a familiar place feel like yours.</p></div>
		<div class="message reply"><b>Kai</b><time>Today, 09:44</time><p>The tabletop creatures are my favorite. There's always another one to find.</p></div>
		<div class="quiet-space"><span>YOUR POINTER CAN EXPLORE HERE</span></div>
		<button id="passthrough" onclick={() => clicks++}>Continue the conversation <span>{clicks}</span></button>
		<footer>Effects remain separate from theme and background settings.</footer>
	</section>
</main>

<style>
	:global(*) { box-sizing: border-box; }
	:global(body) { margin: 0; color: var(--text-heading); background: #12151e; font-family: var(--font-sans, system-ui); font-size: 14px; }
	:global(:root) { --font-size-xs: 12px; --font-size-sm: 13px; --font-size-base: 14px; --accent-primary-color: #b0a4fa; --accent-primary: #b0a4fa; --text-heading: #edf0fa; --text-secondary: #bdc4d7; --text-muted: #7e8aa7; --surface-raised: #252a3d; --surface-sunken: #12151e; --border-subtle: #3c4256; }
	main { display: grid; grid-template-columns: 530px minmax(0, 1fr); height: 100vh; }
	aside { overflow: auto; padding: 30px; background: #1a1e2b; border-right: 1px solid #343b51; }
	header { margin-bottom: 30px; }
	header span, .stage-intro > span { color: #aaa5d5; font-size: 10px; letter-spacing: .14em; }
	h1 { font-size: 25px; letter-spacing: -.04em; font-weight: 550; }
	header p { color: #939cb3; font-size: 12px; }
	#pointer-stage { padding: 48px; overflow: hidden; position: relative; background: radial-gradient(ellipse at 80% 0, #1e2440, transparent 55%), #12151e; }
	.stage-intro { max-width: 580px; margin-bottom: 55px; }
	h2 { font-size: 40px; font-weight: 500; margin-bottom: 14px; letter-spacing: -.055em; }
	.stage-intro p, .message p { line-height: 1.6; color: #a6b0c8; }
	.message { padding: 22px; border: 1px solid #30394f; background: #1c2231a8; border-radius: 16px; max-width: 660px; }
	.message b { color: #cac1ff; margin-right: 14px; }
	.message time { color: #6f7d9b; font-size: 11px; }
	.message p { margin-bottom: 0; }
	.reply { margin: 18px 0 0 55px; }
	.quiet-space { height: 330px; display: grid; place-items: center; }
	.quiet-space span { color: #343d54; font-size: 10px; letter-spacing: .16em; }
	#passthrough { background: #242b40; border: 1px solid #48516d; border-radius: 12px; color: #c2cbe0; padding: 18px 24px; font: inherit; }
	#passthrough span { margin-left: 30px; color: #b0a4fa; }
	footer { margin-top: 24px; color: #69758f; font-size: 11px; }
	:global(.theme-select) { color: var(--text-heading); background: #141925; border: 1px solid #414963; border-radius: 8px; padding: 7px; }
	@media (max-width: 700px) { main { display: block; } aside { width: 100%; height: 100vh; padding: 16px; } #pointer-stage { display: none; } }
</style>
