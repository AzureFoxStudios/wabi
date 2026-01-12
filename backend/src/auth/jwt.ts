import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_EXPIRES_IN = '30d';

export interface TokenPayload {
	sessionId: string;
	userId: number | null;
	isTemporary: boolean;
}

export function generateToken(payload: TokenPayload): string {
	return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token: string): TokenPayload {
	try {
		return jwt.verify(token, JWT_SECRET) as TokenPayload;
	} catch (error) {
		throw new Error('Invalid or expired token');
	}
}
