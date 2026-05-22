import type { HomeExperienceMode } from '$lib/homeExperience';

export interface LoginValidationResult {
	valid: boolean;
	error?: string;
}

export function validateUsername(username: string): LoginValidationResult {
	if (username.length < 2) {
		return { valid: false, error: 'Username must be at least 2 characters' };
	}
	return { valid: true };
}

export function validateHandle(handle: string): LoginValidationResult {
	const cleanHandle = handle.replace(/^@/, '').toLowerCase();
	if (!/^[a-z][a-z0-9_]{1,31}$/.test(cleanHandle)) {
		return { valid: false, error: 'Handle must start with a letter and contain only lowercase letters, numbers, and underscores' };
	}
	return { valid: true, error: undefined };
}

export function validatePassword(password: string): LoginValidationResult {
	if (password.length < 8) {
		return { valid: false, error: 'Password must be at least 8 characters' };
	}
	return { valid: true };
}

export function validatePasswordMatch(password: string, passwordConfirm: string): LoginValidationResult {
	if (password !== passwordConfirm) {
		return { valid: false, error: 'Passwords do not match' };
	}
	return { valid: true };
}

export function validateRegistration(
	username: string,
	handle: string,
	password: string,
	passwordConfirm: string
): LoginValidationResult {
	const usernameResult = validateUsername(username);
	if (!usernameResult.valid) return usernameResult;
	const handleResult = validateHandle(handle);
	if (!handleResult.valid) return handleResult;
	const passwordResult = validatePassword(password);
	if (!passwordResult.valid) return passwordResult;
	const matchResult = validatePasswordMatch(password, passwordConfirm);
	if (!matchResult.valid) return matchResult;
	return { valid: true };
}

export function validateLogin(username: string, password: string): LoginValidationResult {
	if (!username || !password) {
		return { valid: false, error: 'Username and password are required' };
	}
	return { valid: true };
}

export function generateHandleFromUsername(username: string): string {
	return username.replace(/\s+/g, '').toLowerCase();
}

export interface LaunchPageStyleConfig {
	launchContainerStyle: string;
	launchCardStyle: string;
	launchCustomCss: string;
}

export function buildLaunchPageStyles(config: {
	enabled: boolean;
	palette: {
		backgroundTop: string;
		backgroundBottom: string;
		accent: string;
		text: string;
		cardBackground: string;
	};
	backgroundImageUrl?: string;
	customCss?: string;
}): LaunchPageStyleConfig {
	if (!config.enabled) {
		return { launchContainerStyle: '', launchCardStyle: '', launchCustomCss: '' };
	}
	const launchContainerStyle = `--launch-bg-top: ${config.palette.backgroundTop}; --launch-bg-bottom: ${config.palette.backgroundBottom}; --launch-accent: ${config.palette.accent}; --launch-text: ${config.palette.text};${config.backgroundImageUrl ? ` background-image: url(${config.backgroundImageUrl}); background-size: cover; background-position: center;` : ''}`;
	const launchCardStyle = `--launch-card-bg: ${config.palette.cardBackground};`;
	const launchCustomCss = config.customCss || '';
	return { launchContainerStyle, launchCardStyle, launchCustomCss };
}

export type HomeExperienceChoice = 'conversations' | 'community';

export function completeRegistrationHomeExperience(
	mode: HomeExperienceMode,
	pendingLogin: { username: string; token: string } | null,
	saveUserSettings: (token: string, settings: { home_experience: HomeExperienceMode }) => Promise<void>,
	setStoredHomeExperienceMode: (mode: HomeExperienceMode) => void,
	dispatchLogin: (data: { username: string; token: string; authMethod: 'registered'; homeExperience: HomeExperienceMode }) => void
): Promise<{ success: boolean; error?: string }> {
	if (!pendingLogin) return Promise.resolve({ success: false, error: 'No pending login data' });
	return saveUserSettings(pendingLogin.token, { home_experience: mode })
		.then(() => {
			setStoredHomeExperienceMode(mode);
			dispatchLogin({
				username: pendingLogin.username,
				token: pendingLogin.token,
				authMethod: 'registered',
				homeExperience: mode
			});
			return { success: true };
		})
		.catch((err) => ({ success: false, error: err instanceof Error ? err.message : 'Failed to save home experience setting.' }));
}
