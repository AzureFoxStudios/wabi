/**
 * Centralized CORS Configuration
 * Handles CORS policy across both HTTP and Socket.IO
 */

/**
 * Get list of allowed origins from environment or use defaults
 */
export function getAllowedOrigins(): string[] {
	const envOrigins = process.env.ALLOWED_ORIGINS;

	if (envOrigins) {
		// Parse comma-separated list from environment
		return envOrigins.split(',').map(origin => origin.trim()).filter(Boolean);
	}

	// Development defaults
	if (process.env.NODE_ENV !== 'production') {
		return [
			'http://localhost:5173',
			'http://localhost:3000',
			'http://tauri.localhost',
			'http://localhost'
		];
	}

	// Production: require explicit configuration
	return [];
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

	if (process.env.NODE_ENV !== 'production') {
		return callback(null, true); // Dev mode: allow all
	}

	// Production: reject unless whitelisted
	callback(new Error('Not allowed by CORS'));
}
