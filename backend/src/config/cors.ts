/**
 * Centralized CORS Configuration
 * Handles CORS policy across both HTTP and Socket.IO
 */

// Cache allowed origins at module level (computed once at startup)
let cachedOrigins: string[] | null = null;
let corsLoggedAtStartup = false;

function isLoopbackOrigin(value: string | undefined): boolean {
	if (!value) return false;
	try {
		const u = new URL(value);
		return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname.endsWith('.localhost');
	} catch {
		return false;
	}
}

/**
 * Get list of allowed origins from environment or use defaults
 * Cached for performance - recomputed only once at startup
 */
export function getAllowedOrigins(): string[] {
	// Return cached origins on subsequent calls
	if (cachedOrigins !== null) {
		return cachedOrigins;
	}

	const origins: Set<string> = new Set();

	// 1. Explicit ALLOWED_ORIGINS (highest priority)
	const envOrigins = process.env.ALLOWED_ORIGINS;
	if (envOrigins) {
		envOrigins.split(',').map(o => o.trim()).filter(Boolean).forEach(o => origins.add(o));
	}

	// 2. Auto-derive from FRONTEND_URL (set in all deployment configs)
	if (process.env.FRONTEND_URL) {
		origins.add(process.env.FRONTEND_URL.replace(/\/$/, ''));
	}

	// 3. Auto-derive from PUBLIC_URL
	if (process.env.PUBLIC_URL) {
		origins.add(process.env.PUBLIC_URL.replace(/\/$/, ''));
	}

	// 4. Tauri desktop origins (always allowed — these are reserved Tauri webview origins)
	['https://tauri.localhost', 'http://tauri.localhost', 'tauri://localhost'].forEach(o => origins.add(o));

	// 5. Development defaults
	if (process.env.NODE_ENV !== 'production') {
		['http://localhost:5173', 'http://localhost:3000',
		 'http://tauri.localhost', 'http://localhost'].forEach(o => origins.add(o));
	}

	cachedOrigins = Array.from(origins);

	// Log once at startup only
	if (!corsLoggedAtStartup) {
		corsLoggedAtStartup = true;
		if (process.env.NODE_ENV === 'production' && cachedOrigins.length === 0) {
			console.error('[CORS] WARNING: No allowed origins in production! Set ALLOWED_ORIGINS or FRONTEND_URL.');
		} else if (process.env.NODE_ENV === 'production') {
			console.log('[CORS] Allowed origins configured:', cachedOrigins);
		}
	}

	return cachedOrigins;
}

/**
 * Validate if an origin is allowed
 */
export function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
	if (!origin) {
		return true; // Same-origin requests don't have Origin header
	}

	// In development, allow localhost variations
	if (process.env.NODE_ENV !== 'production' && origin.includes('localhost')) {
		return true;
	}

	// Local self-host convenience:
	// If any configured allowed origin is loopback, allow loopback port variations.
	// This prevents local prod-like runs from breaking when frontend/backend ports differ.
	if (isLoopbackOrigin(origin) && allowedOrigins.some((o) => isLoopbackOrigin(o))) {
		return true;
	}

	// Check against whitelist
	return allowedOrigins.includes(origin);
}

/**
 * Get CORS headers for a response
 */
export function getCORSHeaders(origin: string | undefined): Record<string, string> {
	const allowedOrigins = getAllowedOrigins();
	const isAllowed = isOriginAllowed(origin, allowedOrigins);

	const headers: Record<string, string> = {
		'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
		'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With, Authorization, X-Media-Gateway-Key, ngrok-skip-browser-warning',
		'Access-Control-Allow-Credentials': 'true',
		'Access-Control-Max-Age': '86400',
		// Security headers
		'X-Content-Type-Options': 'nosniff',
		'X-Frame-Options': 'DENY',
		'Referrer-Policy': 'strict-origin-when-cross-origin',
		'X-XSS-Protection': '0',
		'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()'
	};

	if (process.env.NODE_ENV === 'production') {
		headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
	}

	if (isAllowed && origin) {
		headers['Access-Control-Allow-Origin'] = origin;
	} else if (process.env.NODE_ENV !== 'production' && origin?.includes('localhost')) {
		headers['Access-Control-Allow-Origin'] = origin;
	}

	return headers;
}

/**
 * Socket.IO CORS callback
 */
export function corsCallback(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void): void {
	const allowedOrigins = getAllowedOrigins();

	if (!origin) {
		return callback(null, true); // Same-origin
	}

	if (isOriginAllowed(origin, allowedOrigins)) {
		return callback(null, true);
	}

	// Production: reject unless whitelisted
	console.error(`[CORS] Rejected origin: "${origin}". Allowed: [${allowedOrigins.join(', ')}]`);
	callback(new Error(`Not allowed by CORS: origin "${origin}" not in allowed list`));
}

