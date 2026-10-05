import assert from 'node:assert/strict';
import test from 'node:test';
import { CarouselSlot } from '../src/lib/server/carousel.ts';

function fixture() {
	let slot;
	let alarm;
	const updates = [];
	const storage = {
		get: async () => slot,
		put: async (_, value) => { slot = value; },
		delete: async () => { slot = undefined; },
		setAlarm: async (value) => { alarm = value; }
	};
	const DB = { prepare: (sql) => ({ bind: (...values) => ({ run: async () => { updates.push({ sql, values }); return { success: true, meta: { changes: 1 } }; } }) }) };
	const object = new CarouselSlot({ storage }, { DB, STRIPE_SECRET_KEY: 'test-only' });
	const call = async (path, body) => {
		const response = await object.fetch(new Request(`https://carousel.internal${path}`, body ? { method: 'POST', body: JSON.stringify(body) } : undefined));
		return { status: response.status, ...(await response.json()) };
	};
	return { object, call, updates, get slot() { return slot; }, get alarm() { return alarm; } };
}

test('paid checkout confirmed after reservation starts a full 24-hour placement', async () => {
	const clock = Date.now;
	const network = globalThis.fetch;
	let time = 1_000_000_000;
	Date.now = () => time;
	try {
		const f = fixture();
		const reserved = (await f.call('/reserve', { listingId: 7, sellerId: 3 })).slot;
		await f.call('/checkout', { reservationId: reserved.reservationId, orderId: 9, sessionId: 'cs_paid' });
		time += 36 * 60 * 1000;
		globalThis.fetch = async () => Response.json({ id: 'cs_paid', status: 'complete', payment_status: 'paid' });
		const active = (await f.call('/')).slot;
		assert.equal(active.status, 'paid');
		assert.equal(active.expiresAt - active.startsAt, 24 * 60 * 60 * 1000);
		assert.equal(f.alarm, active.expiresAt);
		assert.match(f.updates[0].sql, /status = 'paid'/);
		time = active.expiresAt - 1;
		assert.equal((await f.call('/')).slot.status, 'paid');
		time++;
		assert.equal((await f.call('/')).slot.status, 'available');
	} finally { Date.now = clock; globalThis.fetch = network; }
});

test('expired checkout releases an unpaid reservation', async () => {
	const clock = Date.now;
	const network = globalThis.fetch;
	let time = 1_000_000_000;
	Date.now = () => time;
	try {
		const f = fixture();
		const reserved = (await f.call('/reserve', { listingId: 7, sellerId: 3 })).slot;
		await f.call('/checkout', { reservationId: reserved.reservationId, orderId: 9, sessionId: 'cs_expired' });
		time += 36 * 60 * 1000;
		globalThis.fetch = async () => Response.json({ id: 'cs_expired', status: 'expired', payment_status: 'unpaid' });
		assert.equal((await f.call('/')).slot.status, 'available');
		assert.match(f.updates[0].sql, /status = 'expired'/);
	} finally { Date.now = clock; globalThis.fetch = network; }
});
