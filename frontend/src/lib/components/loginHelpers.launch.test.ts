import { describe, expect, test } from 'bun:test';
import { buildLaunchPageStyles, hasOperatorLaunchStyling } from './loginHelpers';

describe('operator launch styling', () => {
	test('a disabled page that only carries the stock accent follows the theme', () => {
		expect(hasOperatorLaunchStyling({ enabled: false, palette: { accent: '#5865F2' } }, false)).toBe(false);
		expect(hasOperatorLaunchStyling(null, false)).toBe(false);
	});
	test('a custom accent, any explicit colour, a backdrop, or an enabled page is operator branding', () => {
		expect(hasOperatorLaunchStyling({ enabled: false, palette: { accent: '#ff4d8d' } }, false)).toBe(true);
		expect(hasOperatorLaunchStyling({ enabled: false, palette: { backgroundTop: '#101010' } }, false)).toBe(true);
		expect(hasOperatorLaunchStyling({ enabled: false, backgroundImageUrl: '/uploads/login.jpg', palette: { accent: '#5865f2' } }, false)).toBe(true);
		expect(hasOperatorLaunchStyling({ enabled: true, palette: {} }, false)).toBe(true);
	});
	test('neutral branding always follows the theme', () => {
		expect(hasOperatorLaunchStyling({ enabled: true, palette: { accent: '#ff4d8d' } }, true)).toBe(false);
	});
});

describe('buildLaunchPageStyles', () => {
	const empty = { backgroundTop: '', backgroundBottom: '', accent: '', text: '', cardBackground: '' };
	test('emits only what the operator set — no baked-in navy or teal', () => {
		const styles = buildLaunchPageStyles({ enabled: true, palette: { ...empty, accent: '#ff4d8d' } });
		expect(styles.launchContainerStyle).toContain('--launch-accent: #ff4d8d;');
		expect(styles.launchContainerStyle).not.toContain('--launch-bg-top');
		expect(styles.launchCardStyle).toBe('');
	});
	test('an enabled page with no colours contributes no variables', () => {
		expect(buildLaunchPageStyles({ enabled: true, palette: empty }).launchContainerStyle).toBe('');
	});
	test('a backdrop image survives on its own', () => {
		const styles = buildLaunchPageStyles({ enabled: true, palette: empty, backgroundImageUrl: '/uploads/login.jpg' });
		expect(styles.launchContainerStyle).toContain('background-image');
	});
});
