const encoder = new TextEncoder();

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function base64UrlEncode(value: string | Uint8Array): string {
	const bytes = typeof value === 'string' ? encoder.encode(value) : value;
	return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlDecode(value: string): Uint8Array {
	const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
	return base64ToBytes(padded);
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256(value: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

export async function hashPassword(password: string, salt?: Uint8Array, iterations = 120000) {
	const actualSalt = salt ?? crypto.getRandomValues(new Uint8Array(16));
	const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: arrayBuffer(actualSalt), iterations, hash: 'SHA-256' }, key, 256);
	return { hash: bytesToBase64(new Uint8Array(bits)), salt: bytesToBase64(actualSalt), iterations };
}

export async function verifyPassword(password: string, encodedHash: string, encodedSalt: string, iterations: number) {
	const result = await hashPassword(password, base64ToBytes(encodedSalt), iterations);
	return result.hash === encodedHash;
}

export async function signHs256(input: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	return base64UrlEncode(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(input))));
}

export async function verifyHs256(input: string, signature: string, secret: string): Promise<boolean> {
	const expected = await signHs256(input, secret);
	return expected === signature;
}

export async function encryptText(plaintext: string, secret: string): Promise<string> {
	const keyMaterial = await sha256(secret);
	const key = await crypto.subtle.importKey('raw', arrayBuffer(keyMaterial), { name: 'AES-GCM' }, false, ['encrypt']);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext)));
	const output = new Uint8Array(iv.length + ciphertext.length);
	output.set(iv);
	output.set(ciphertext, iv.length);
	return bytesToBase64(output);
}

export function randomSecret(bytes = 20): string {
	return bytesToBase64(crypto.getRandomValues(new Uint8Array(bytes)));
}

const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(value: string): Uint8Array {
	const normalized = value.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
	let buffer = 0;
	let bits = 0;
	const output: number[] = [];
	for (const char of normalized) {
		const index = base32Alphabet.indexOf(char);
		if (index < 0) throw new Error('Invalid TOTP secret');
		buffer = (buffer << 5) | index;
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			output.push((buffer >> bits) & 255);
		}
	}
	return new Uint8Array(output);
}

export async function verifyTotp(secret: string, code: string, now = Date.now()): Promise<boolean> {
	if (!/^\d{6}$/.test(code)) return false;
	const secretBytes = decodeBase32(secret);
	const key = await crypto.subtle.importKey('raw', arrayBuffer(secretBytes), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
	for (const offset of [-1, 0, 1]) {
		const counter = Math.floor(now / 30000) + offset;
		const counterBytes = new Uint8Array(8);
		let remaining = counter;
		for (let index = 7; index >= 0; index--) {
			counterBytes[index] = remaining & 255;
			remaining = Math.floor(remaining / 256);
		}
		const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBytes));
		const start = digest[digest.length - 1] & 15;
		const number = ((digest[start] & 127) << 24) | (digest[start + 1] << 16) | (digest[start + 2] << 8) | digest[start + 3];
		if ((number % 1000000).toString().padStart(6, '0') === code) return true;
	}
	return false;
}

export function toBase32(bytes: Uint8Array): string {
	let output = '';
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			output += base32Alphabet[(buffer >> bits) & 31];
		}
	}
	if (bits > 0) output += base32Alphabet[(buffer << (5 - bits)) & 31];
	return output;
}

export { base64UrlDecode, base64UrlEncode, bytesToBase64, hex };
