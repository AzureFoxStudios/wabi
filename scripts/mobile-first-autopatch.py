from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
layout = ROOT / 'frontend/src/lib/components/MainLayout.svelte'
css = ROOT / 'frontend/src/styles/components/mobile-shell.css'

text = layout.read_text()


def replace_once(old: str, new: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'expected exactly one match, got {count}: {old[:120]!r}')
    text = text.replace(old, new, 1)

replace_once(
    "\timport InstallAppBanner from '$lib/components/pwa/InstallAppBanner.svelte';\n",
    "\timport InstallAppBanner from '$lib/components/pwa/InstallAppBanner.svelte';\n"
    "\timport { formatMobileUnreadBadge, sumUnreadConversationCount } from '$lib/mobileShellModel';\n",
)

replace_once(
    "\t$: totalUnreadDMs = 0; // DM-strip: was Object.entries($channelUnreadCounts) for DM channels. Stubbed to 0.\n",
    "\t$: totalUnreadDMs = sumUnreadConversationCount($channelUnreadCounts, $channels);\n"
    "\t$: mobileUnreadBadge = formatMobileUnreadBadge(totalUnreadDMs);\n",
)

replace_once(
    "\t\t// P3: on mobile the bottom nav starts visible, then auto-hides after\n"
    "\t\t// the idle timeout and reappears on interaction (grabber, swipe, touch).\n"
    "\t\tif ($layoutStore.isMobile && !$layoutStore.isInCall) {\n"
    "\t\t\tmobileNavVisible = true;\n"
    "\t\t\tscheduleMobileNavIdleHide();\n"
    "\t\t}\n",
    "\t\t// Mobile navigation is structural chrome, not transient decoration.\n"
    "\t\t// Keep it present while the phone shell is active; the keyboard and\n"
    "\t\t// full-screen call surfaces are the only normal takeovers.\n"
    "\t\tif ($layoutStore.isMobile && !$layoutStore.isInCall) {\n"
    "\t\t\tmobileNavVisible = true;\n"
    "\t\t}\n",
)

replace_once(
    "\tfunction scheduleMobileNavIdleHide(): void {\n"
    "\t\tif (!$layoutStore.isMobile || !mobileNavVisible || $layoutStore.isInCall) return;\n"
    "\t\tif (mobileNavIdleTimer) clearTimeout(mobileNavIdleTimer);\n"
    "\t\tmobileNavIdleTimer = setTimeout(() => {\n"
    "\t\t\tmobileNavVisible = false;\n"
    "\t\t\tmobileNavIdleTimer = null;\n"
    "\t\t}, MOBILE_NAV_IDLE_HIDE_MS);\n"
    "\t}\n\n"
    "\tfunction hideMobileNavNow(): void {\n"
    "\t\tmobileNavVisible = false;\n"
    "\t\tif (mobileNavIdleTimer) {\n"
    "\t\t\tclearTimeout(mobileNavIdleTimer);\n"
    "\t\t\tmobileNavIdleTimer = null;\n"
    "\t\t}\n"
    "\t}\n",
    "\tfunction scheduleMobileNavIdleHide(): void {\n"
    "\t\t// Intentionally persistent. Older mobile chrome disappeared after\n"
    "\t\t// 2.2 seconds, making ordinary reading feel like a hidden-gesture UI.\n"
    "\t\tif ($layoutStore.isMobile && !$layoutStore.isInCall) mobileNavVisible = true;\n"
    "\t}\n\n"
    "\tfunction hideMobileNavNow(): void {\n"
    "\t\t// Retained for old gesture call sites; root navigation no longer hides\n"
    "\t\t// merely because the user pulled or paused.\n"
    "\t\tif ($layoutStore.isMobile && !$layoutStore.isInCall) mobileNavVisible = true;\n"
    "\t}\n",
)

replace_once(
    "\t$: if (!$layoutStore.isMobile || $layoutStore.isInCall) {\n"
    "\t\tmobileNavVisible = false;\n"
    "\t\tif (mobileNavIdleTimer) {\n"
    "\t\t\tclearTimeout(mobileNavIdleTimer);\n"
    "\t\t\tmobileNavIdleTimer = null;\n"
    "\t\t}\n"
    "\t}\n\n"
    "\t$: if (mobileNavVisible && $layoutStore.isMobile && !$layoutStore.isInCall) {\n"
    "\t\tscheduleMobileNavIdleHide();\n"
    "\t}\n",
    "\t$: if (!$layoutStore.isMobile || $layoutStore.isInCall) {\n"
    "\t\tmobileNavVisible = false;\n"
    "\t\tif (mobileNavIdleTimer) {\n"
    "\t\t\tclearTimeout(mobileNavIdleTimer);\n"
    "\t\t\tmobileNavIdleTimer = null;\n"
    "\t\t}\n"
    "\t} else if (!mobileNavVisible) {\n"
    "\t\tmobileNavVisible = true;\n"
    "\t}\n",
)

replace_once(
    "\t\t\t<svg width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><path d=\"M4 4h16v12H5.17L4 17.17V4z\"/><path d=\"M8 8h8M8 12h5\"/></svg>\n"
    "\t\t\t<span>{$_('shell.mobile.messages')}</span>\n",
    "\t\t\t<span class=\"mobile-nav-icon-wrap\">\n"
    "\t\t\t\t<svg width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><path d=\"M4 4h16v12H5.17L4 17.17V4z\"/><path d=\"M8 8h8M8 12h5\"/></svg>\n"
    "\t\t\t\t{#if mobileUnreadBadge}\n"
    "\t\t\t\t\t<span class=\"mobile-nav-badge\" aria-label={`${totalUnreadDMs} unread messages`}>{mobileUnreadBadge}</span>\n"
    "\t\t\t\t{/if}\n"
    "\t\t\t</span>\n"
    "\t\t\t<span>{$_('shell.mobile.messages')}</span>\n",
)

layout.write_text(text)

css_text = css.read_text()
marker = '/* MOBILE-FIRST ROOT NAV — persistent, glanceable, badge-aware */'
if marker not in css_text:
    css_text += f'''\n\n{marker}\n@media (max-width: 768px) {{\n\t.mobile-bottom-nav {{\n\t\ttransform: translateY(0) !important;\n\t\topacity: 1 !important;\n\t\tpointer-events: auto !important;\n\t}}\n\n\t.mobile-nav-grabber {{\n\t\tdisplay: none !important;\n\t}}\n\n\t.mobile-nav-icon-wrap {{\n\t\tposition: relative;\n\t\tdisplay: inline-grid;\n\t\tplace-items: center;\n\t}}\n\n\t.mobile-nav-badge {{\n\t\tposition: absolute;\n\t\ttop: -7px;\n\t\tright: -13px;\n\t\tmin-width: 17px;\n\t\theight: 17px;\n\t\tpadding: 0 4px;\n\t\tbox-sizing: border-box;\n\t\tdisplay: inline-flex;\n\t\talign-items: center;\n\t\tjustify-content: center;\n\t\tborder-radius: 999px;\n\t\tborder: 2px solid var(--surface-raised, #111827);\n\t\tbackground: var(--color-danger, #ef4444);\n\t\tcolor: white;\n\t\tfont-size: 10px;\n\t\tfont-weight: 800;\n\t\tline-height: 1;\n\t\tletter-spacing: 0;\n\t}}\n\n\t/* Keep touch targets stable: root navigation must never require a reveal gesture. */\n\t.mobile-bottom-nav button {{\n\t\tposition: relative;\n\t\tmin-width: 0;\n\t\tmin-height: 48px;\n\t}}\n}}\n'''
    css.write_text(css_text)

print('mobile-first patch applied')
