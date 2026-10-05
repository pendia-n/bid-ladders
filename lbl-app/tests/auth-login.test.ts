import { describe, expect, it } from 'vitest';
import { completeTotpLogin, loginUser } from '../src/lib/server/auth';
import { hashPassword, toBase32 } from '../src/lib/server/crypto';

async function currentCode(secretBytes: Uint8Array): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new Uint8Array(secretBytes), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
	const counter = Math.floor(Date.now() / 30000);
	const bytes = new Uint8Array(8);
	let remaining = counter;
	for (let index = 7; index >= 0; index--) { bytes[index] = remaining & 255; remaining = Math.floor(remaining / 256); }
	const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes));
	const offset = digest[digest.length - 1] & 15;
	const number = ((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
	return (number % 1000000).toString().padStart(6, '0');
}

describe('TOTP login', () => {
	it('requires a password-issued challenge before accepting the authenticator code', async () => {
		const password = 'CorrectPassword123';
		const passwordData = await hashPassword(password, undefined, 1000);
		const secretBytes = crypto.getRandomValues(new Uint8Array(20));
		const secret = toBase32(secretBytes);
		const user = { id: 1, username: 'seller', role: 'seller', totp_enabled: 1, password_hash: passwordData.hash, password_salt: passwordData.salt, password_iterations: passwordData.iterations };
		const db = { prepare: (sql: string) => ({ bind: () => ({ first: async () => sql.includes('totp_secret') ? { totp_secret: secret, totp_enabled: 1 } : user }) }) };
		const event = { platform: { env: { DB: db, JWT_SECRET: 'test-signing-secret' } }, request: new Request('https://example.test') } as any;
		const code = await currentCode(secretBytes);
		await expect(completeTotpLogin(event, '', code)).rejects.toThrow();
		await expect(loginUser(event, 'seller', 'wrong-password')).rejects.toThrow();
		const firstStep = await loginUser(event, 'seller', password);
		expect(firstStep.totpRequired).toBe(true);
		const complete = await completeTotpLogin(event, firstStep.loginChallenge!, code);
		expect(complete.token).toBeTruthy();
	});
});
