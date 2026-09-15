<svelte:head>
	<title>Privacy · Wabi</title>
	<meta name="description" content="Privacy information for the Wabi open-source communication project and the default Wabi distribution." />
	<link rel="canonical" href="https://wabi.chat/privacy" />
</svelte:head>

<main class="legal-page">
	<article>
		<nav><a href="/">← Back to Wabi</a></nav>
		<p class="eyebrow">Legal</p>
		<h1>Privacy</h1>
		<p class="lede">Wabi is built to be self-hostable. That means the operator of the server you use can matter as much as the Wabi software itself.</p>

		<h2>Scope</h2>
		<p>This page describes the Wabi project and the default Wabi distribution. A third-party or self-hosted Wabi instance may be configured differently and may publish its own privacy terms. When an instance-specific policy conflicts with this page, ask that instance operator how it handles data.</p>

		<h2>Information Wabi may process</h2>
		<p>Depending on how an instance is configured and which features you use, Wabi may process account information, profile information, messages and attachments, workspace content, call or connection metadata, device and session information, settings, and security-related logs needed to operate the service.</p>

		<h2>Where information is stored</h2>
		<p>Wabi is designed for independent hosting. Content and account data are generally handled by the Wabi instance you connect to, while some preferences and offline data may also be stored on your device. Instance operators are responsible for their own hosting, backups, retention, access controls, and infrastructure providers.</p>

		<h2>Analytics and advertising</h2>
		<p>The default Wabi project does not require advertising trackers or behavioral advertising. If privacy-respecting aggregate telemetry is introduced in a hosted Wabi service, this policy should be updated before that data collection is relied upon. Independent instance operators may make different choices and should disclose them.</p>

		<h2>Cookies and local storage</h2>
		<p>Wabi may use browser storage, local databases, caches, or technically necessary session mechanisms to keep you signed in, remember settings, support offline behavior, and keep the application working. The project does not add a consent banner merely for technically necessary storage.</p>

		<h2>Sharing and third parties</h2>
		<p>Wabi does not need to sell personal information to operate the project. Data may nevertheless pass through infrastructure selected by an instance operator, such as hosting, relay, storage, authentication, or networking providers. Features or add-ons that connect to outside services may also send information to those services when you choose to use them.</p>

		<h2>Security</h2>
		<p>Wabi aims to use reasonable technical safeguards, but no software or network service can guarantee absolute security. Server operators should keep their Wabi deployment and dependencies current, restrict administrative access, and use appropriate backups and transport security.</p>

		<h2>Your choices</h2>
		<p>Your available account, deletion, export, or retention controls can depend on the instance you use and its operator. For instance-specific requests, contact that server operator. For issues with the Wabi project itself, use the project contact channels linked from the Wabi repository or website.</p>

		<h2>Changes</h2>
		<p>This policy may change as Wabi adds features or hosted services. Material changes should be reflected on this page with the effective date below.</p>

		<p class="updated">Effective: September 14, 2026</p>
		<footer><a href="/terms">Terms</a><span aria-hidden="true">·</span><a href="https://github.com/AzureFoxStudios/wabi">Source code</a></footer>
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