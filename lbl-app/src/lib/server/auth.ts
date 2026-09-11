import type { RequestEvent } from '@sveltejs/kit';
import type { D1Database } from '@cloudflare/workers-types';
import type { R2Bucket } from '@cloudflare/workers-types';
import type { DurableObjectNamespace } from '@cloudflare/workers-types';
import { base64UrlDecode, base64UrlEncode, hashPassword, signHs256, toBase32, verifyHs256, verifyPassword, verifyTotp } from './crypto';

export type Role = 'seller' | 'buyer';

export type EnvBindings = {
	DB?: D1Database;
	MEDIA?: R2Bucket;
	CAROUSEL_SLOTS?: DurableObjectNamespace;
	JWT_SECRET?: string;
	ENCRYPTION_KEY?: string;
	STRIPE_SECRET_KEY?: string;
	STRIPE_WEBHOOK_SECRET?: string;
	ESCROW_API_EMAIL?: string;
	ESCROW_API_KEY?: string;
	ESCROW_API_BASE_URL?: string;
	ESCROW_WEBHOOK_SECRET?: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	APP_URL?: string;
};

export type AuthUser = {
	id: number;
	username: string;
	role: Role;
	totp_enabled: number;
	profile_image_key?: string | null;
	display_name?: string | null;
	bio?: string | null;
	website?: string | null;
	country?: string | null;
	timezone?: string | null;
	contact_email?: string | null;
};

export function envFrom(event: RequestEvent): EnvBindings {
	return (event.platform as { env?: EnvBindings } | undefined)?.env ?? {};
}

export function getDb(event: RequestEvent): D1Database {
	const db = envFrom(event).DB;
	if (!db) throw new Error('D1 binding DB is not configured');
	return db;
}

function jwtSecret(event: RequestEvent): string {
	return envFrom(event).JWT_SECRET ?? 'local-development-only-change-me';
}

export async function createToken(event: RequestEvent, user: AuthUser): Promise<string> {
	const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
	const payload = base64UrlEncode(JSON.stringify({ sub: user.id, username: user.username, role: user.role, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 28 * 24 * 60 * 60 }));
	const input = `${header}.${payload}`;
	return `${input}.${await signHs256(input, jwtSecret(event))}`;
}

export async function userFromToken(event: RequestEvent): Promise<AuthUser | null> {
	const authorization = event.request.headers.get('authorization');
	if (!authorization?.startsWith('Bearer ')) return null;
	const token = authorization.slice(7);
	const [encodedHeader, encodedPayload, signature] = token.split('.');
	if (!encodedHeader || !encodedPayload || !signature || !(await verifyHs256(`${encodedHeader}.${encodedPayload}`, signature, jwtSecret(event)))) return null;
	try {
		const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload))) as { sub: number; exp: number };
		if (!payload.sub || payload.exp < Math.floor(Date.now() / 1000)) return null;
		const user = await getDb(event).prepare('SELECT id, username, role, totp_enabled, profile_image_key, display_name, bio, website, country, timezone, contact_email FROM users WHERE id = ?').bind(payload.sub).first<AuthUser>();
		return user ?? null;
	} catch {
		return null;
	}
}

export async function requireUser(event: RequestEvent): Promise<AuthUser> {
	const user = await userFromToken(event);
	if (!user) throw new Response(JSON.stringify({ error: 'Sign in required' }), { status: 401, headers: { 'content-type': 'application/json' } });
	return user;
}

export async function registerUser(event: RequestEvent, username: string, password: string, role: Role, totpSecretInput = '', totpCode = '') {
	const normalized = username.trim().toLowerCase();
	if (!/^[a-z0-9_]{3,24}$/.test(normalized)) throw new Error('Username must be 3-24 characters using letters, numbers, or underscores');
	if (password.length < 12 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) throw new Error('Password must be 12+ characters with upper, lower, and number characters');
	const passwordData = await hashPassword(password);
	const totpSecret = totpSecretInput.trim() || null;
	if (totpSecret && !(await verifyTotp(totpSecret, totpCode))) throw new Error('Scan the QR code and enter a valid authenticator code');
	const result = await getDb(event).prepare('INSERT INTO users (username, password_hash, password_salt, password_iterations, role, totp_secret, totp_enabled) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(normalized, passwordData.hash, passwordData.salt, passwordData.iterations, role, totpSecret, totpSecret ? 1 : 0).run();
	const user = await getDb(event).prepare('SELECT id, username, role, totp_enabled, profile_image_key, display_name, bio, website, country, timezone, contact_email FROM users WHERE id = ?').bind(result.meta.last_row_id).first<AuthUser>();
	if (!user) throw new Error('Unable to create account');
	return { user, token: await createToken(event, user) };
}

export async function loginUser(event: RequestEvent, username: string, password: string) {
	const userRecord = await getDb(event).prepare('SELECT * FROM users WHERE username = ?').bind(username.trim().toLowerCase()).first<any>();
	if (!userRecord || !(await verifyPassword(password, userRecord.password_hash, userRecord.password_salt, userRecord.password_iterations))) throw new Error('Invalid username or password');
	const user: AuthUser = { id: userRecord.id, username: userRecord.username, role: userRecord.role, totp_enabled: userRecord.totp_enabled, profile_image_key: userRecord.profile_image_key, display_name: userRecord.display_name, bio: userRecord.bio, website: userRecord.website, country: userRecord.country, timezone: userRecord.timezone, contact_email: userRecord.contact_email };
	if (user.totp_enabled) return { user, totpRequired: true, userId: user.id };
	return { user, token: await createToken(event, user) };
}

export async function completeTotpLogin(event: RequestEvent, userId: number, code: string) {
	const user = await getDb(event).prepare('SELECT id, username, role, totp_enabled, profile_image_key, display_name, bio, website, country, timezone, contact_email FROM users WHERE id = ?').bind(userId).first<AuthUser>();
	if (!user || !user.totp_enabled || !(await verifyUserTotp(event, user, code))) throw new Error('Invalid TOTP code');
	return { user, token: await createToken(event, user) };
}

export async function verifyUserTotp(event: RequestEvent, user: AuthUser, code: string): Promise<boolean> {
	const record = await getDb(event).prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').bind(user.id).first<{ totp_secret: string | null; totp_enabled: number }>();
	return !!record?.totp_enabled && !!record.totp_secret && (await verifyTotp(record.totp_secret, code));
}
