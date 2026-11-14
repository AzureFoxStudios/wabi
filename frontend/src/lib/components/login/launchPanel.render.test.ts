/** Finding L3 at its call site: the real LaunchPanel, rendered, with a hostile launch page. */
import { expect, test } from 'bun:test';
import { registerSvelteServerPlugin } from '../../../../test/svelteServerPlugin';

registerSvelteServerPlugin();
const { render } = await import('svelte/server');
const { default: LaunchPanel } = await import('./LaunchPanel.svelte');

function panel(url: string): string {
	return render(LaunchPanel as any, { props: { config: { brandName: 'Wabi', heroPrimaryCtaLabel: 'Join', heroPrimaryCtaUrl: url } } }).body;
}

test('a server-chosen call to action renders only as an http(s) link', () => {
	expect(panel('https://community.example/join')).toMatch(/<a class="launch-primary-cta[^"]*" href="https:\/\/community\.example\/join"/);
	// The rendered href is the checked, normalised value, not the server's raw string.
	expect(panel('  https://COMMUNITY.example/join  ')).toMatch(/href="https:\/\/community\.example\/join"/);
	for (const url of ['javascript:alert(document.domain)', ' JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'ms-msdt:/id x', '//evil.example']) {
		const html = panel(url);
		expect({ url, link: /launch-primary-cta/.test(html) }).toEqual({ url, link: false });
		expect(html).not.toContain('javascript:');
	}
});
