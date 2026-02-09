/**
 * Centralized CORS Configuration
 * Handles CORS policy across both HTTP and Socket.IO
 */

// Cache allowed origins at module level (computed once at startup)
let cachedOrigins: string[] | null = null;
let corsLoggedAtStartup = false;

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
		'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With, Authorization',
		'Access-Control-Allow-Credentials': 'true',
		'Access-Control-Max-Age': '86400'
	};

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

