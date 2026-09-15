<script lang="ts">
	import '../../styles/public-pages.css';
</script>

<svelte:head>
	<title>Privacy · Wabi</title>
	<meta name="description" content="Privacy information for the Wabi open-source communication project and the default Wabi distribution." />
	<link rel="canonical" href="https://wabi.chat/privacy" />
</svelte:head>

<div class="public-page">
	<a class="public-skip" href="#main-content">Skip to content</a>
	<header class="public-header" id="page-top">
		<a class="public-home" href="/" aria-label="Back to Wabi">
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m12 5-7 7 7 7M5 12h14" /></svg>
			<span class="public-mark" aria-hidden="true"></span>
			<span>Wabi</span>
		</a>
		<nav class="public-nav" aria-label="Project information">
			<a href="/privacy" aria-current="page">Privacy</a>
			<a href="/terms">Terms</a>
			<a href="https://github.com/AzureFoxStudios/wabi">Source code</a>
		</nav>
	</header>
	<main class="public-reading" id="main-content" tabindex="-1" aria-labelledby="page-title">
		<article>
			<h1 id="page-title">Privacy</h1>
			<p class="public-effective">Effective: <time datetime="2026-09-14">September 14, 2026</time></p>
			<p class="public-lede">Wabi is built to be self-hostable. That means the operator of the server you use can matter as much as the Wabi software itself.</p>

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
			<p>This policy may change as Wabi adds features or hosted services. Material changes should be reflected on this page with the effective date shown on this page.</p>

		</article>
		<footer class="public-footer">
			<a href="/terms">Terms</a>
			<a href="#page-top">Back to top <span aria-hidden="true">↑</span></a>
		</footer>
	</main>
</div>
