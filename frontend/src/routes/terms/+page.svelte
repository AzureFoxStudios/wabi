<svelte:head>
	<title>Terms · Wabi</title>
	<meta name="description" content="Terms for the Wabi open-source communication project and the default Wabi distribution." />
	<link rel="canonical" href="https://wabi.chat/terms" />
</svelte:head>

<main class="legal-page">
	<article>
		<nav><a href="/">← Back to Wabi</a></nav>
		<p class="eyebrow">Legal</p>
		<h1>Terms</h1>
		<p class="lede">Wabi is open-source software that can be run by independent server operators. These terms cover the Wabi project and default distribution, not every independently operated instance.</p>

		<h2>Using Wabi</h2>
		<p>You may use Wabi subject to the software license and any rules published by the operator of the instance you connect to. Do not use Wabi to violate applicable law, compromise systems, abuse other users, or interfere with the operation of a server.</p>

		<h2>Self-hosted instances</h2>
		<p>Independent Wabi server operators control their own infrastructure, moderation, availability, membership, backups, retention, and local rules. The Wabi project does not automatically control or endorse independently operated instances.</p>

		<h2>Accounts and access</h2>
		<p>You are responsible for protecting credentials associated with your account and for activity performed through your account. Instance operators may suspend, restrict, or remove access in accordance with their own rules or when needed to protect the service.</p>

		<h2>User content</h2>
		<p>You retain responsibility for content you create or upload. You must have the rights necessary to share that content. Wabi's software license does not transfer ownership of user-created messages, files, artwork, code, or other content to the Wabi project.</p>

		<h2>Add-ons and integrations</h2>
		<p>Wabi may support add-ons or integrations made by third parties. Those components can have their own licenses, terms, data practices, and security characteristics. Review them before enabling them on an instance.</p>

		<h2>Open-source software</h2>
		<p>The Wabi source code is provided under the license included with the project repository. If these website terms conflict with rights granted by that open-source license for the software itself, the software license controls those rights.</p>

		<h2>No guarantee of uninterrupted service</h2>
		<p>Wabi is under active development. Features may change, fail, be removed, or behave differently across versions and deployments. To the extent permitted by law, the project is provided without a promise of uninterrupted availability or fitness for a particular purpose.</p>

		<h2>Limitation of responsibility</h2>
		<p>To the extent permitted by applicable law, the Wabi project maintainers are not responsible for losses caused by independently operated servers, third-party infrastructure, add-ons, user content, or misuse of the software. Server operators remain responsible for the services they choose to provide.</p>

		<h2>Changes</h2>
		<p>These terms may change as Wabi evolves. Material changes should be reflected on this page with the effective date below.</p>

		<p class="updated">Effective: September 14, 2026</p>
		<footer><a href="/privacy">Privacy</a><span aria-hidden="true">·</span><a href="https://github.com/AzureFoxStudios/wabi">Source code</a></footer>
	</article>
</main>

<style>
	.legal-page { min-height: 100dvh; padding: clamp(24px, 5vw, 64px) 20px; color: #e5e7eb; }
	article { width: min(760px, 100%); margin: 0 auto; padding: clamp(26px, 5vw, 54px); border: 1px solid rgba(148,163,184,.18); border-radius: 24px; background: rgba(9,14,25,.84); box-shadow: 0 24px 72px rgba(0,0,0,.3); backdrop-filter: blur(18px); }
	nav a, footer a { color: #c7d2fe; text-decoration: none; } nav a:hover, footer a:hover { text-decoration: underline; }
	.eyebrow { margin: 38px 0 8px; color: #a5b4fc; font-size: .78rem; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }
	h1 { margin: 0; font-size: clamp(2.4rem, 8vw, 4.6rem); letter-spacing: -.05em; line-height: .98; }
	.lede { margin: 22px 0 34px; color: #cbd5e1; font-size: 1.15rem; line-height: 1.65; }
	h2 { margin: 34px 0 10px; color: #f8fafc; font-size: 1.08rem; }
	p { color: #cbd5e1; line-height: 1.72; }
	.updated { margin-top: 42px; color: #94a3b8; font-size: .9rem; }
	footer { display: flex; gap: 10px; flex-wrap: wrap; padding-top: 18px; border-top: 1px solid rgba(148,163,184,.16); }
	@media (max-width: 600px) { article { border-radius: 18px; } }
</style>