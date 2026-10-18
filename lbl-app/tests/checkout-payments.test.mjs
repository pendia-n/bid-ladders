import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { checkoutPaymentParameters, fulfillRankCheckout, isPaidCheckoutEvent } from '../src/lib/server/checkout-payments.ts';
import { RankCheckoutExpiry } from '../src/lib/server/rank-checkout-expiry.ts';

function fixture() {
	const sqlite = new DatabaseSync(':memory:');
	sqlite.exec("CREATE TABLE bids (id INTEGER PRIMARY KEY, listing_id INTEGER, seller_id INTEGER, status TEXT, checkout_session_id TEXT, paid_at TEXT, starts_at TEXT, expires_at TEXT); CREATE TABLE rank_reservations (bid_id INTEGER); INSERT INTO bids VALUES (1, 7, 3, 'pending', 'cs_new', NULL, NULL, NULL), (2, 7, 3, 'paid', 'cs_old', NULL, NULL, NULL); INSERT INTO rank_reservations VALUES (1);");
	const DB = {
		prepare: (sql) => ({ bind: (...args) => ({ sql, args, first: async () => sqlite.prepare(sql).get(...args) }) }),
		batch: async (statements) => {
			sqlite.exec('BEGIN');
			try {
				const results = statements.map(({ sql, args }) => ({ meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }));
				sqlite.exec('COMMIT');
				return results;
			} catch (error) { sqlite.exec('ROLLBACK'); throw error; }
		}
	};
	return { sqlite, DB, status: (bidId) => sqlite.prepare('SELECT status FROM bids WHERE id = ?').get(bidId).status };
}

test('both fixed ad pricing and custom rank pricing offer card and stablecoin Checkout', () => {
	for (const amount of ['1000', '350']) {
		const params = checkoutPaymentParameters({ mode: 'payment', 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': amount });
		assert.equal(params.get('payment_method_types[0]'), 'card');
		assert.equal(params.get('payment_method_types[1]'), 'crypto');
		assert.equal(params.get('payment_method_types[2]'), null);
		assert.equal(params.get('line_items[0][price_data][currency]'), 'usd');
		assert.equal(params.get('line_items[0][price_data][unit_amount]'), amount);
	}
});

test('completed and delayed-success events require explicit paid status', () => {
	for (const type of ['checkout.session.completed', 'checkout.session.async_payment_succeeded']) {
		assert.equal(isPaidCheckoutEvent(type, 'paid'), true);
		for (const status of ['unpaid', 'no_payment_required', undefined]) assert.equal(isPaidCheckoutEvent(type, status), false);
	}
	assert.equal(isPaidCheckoutEvent('checkout.session.async_payment_failed', 'paid'), false);
});

test('paid rank replaces the old bid exactly once and requires its saved Checkout ID', async () => {
	const f = fixture();
	try {
		assert.equal(await fulfillRankCheckout(f.DB, 1, 'cs_wrong'), null);
		assert.equal(f.status(1), 'pending');
		assert.ok(await fulfillRankCheckout(f.DB, 1, 'cs_new', 1000000));
		assert.equal(f.status(1), 'paid');
		assert.equal(f.status(2), 'expired');
		assert.equal(f.sqlite.prepare('SELECT count(*) AS count FROM rank_reservations').get().count, 0);
		assert.equal(await fulfillRankCheckout(f.DB, 1, 'cs_new'), null);
	} finally { f.sqlite.close(); }
});

test('rank alarm holds a processing payment, then fulfills once Stripe confirms paid', async () => {
	const f = fixture();
	const network = globalThis.fetch;
	let record;
	let alarm;
	let status = 'unpaid';
	const storage = { get: async () => record, put: async (_, value) => { record = value; }, delete: async () => { record = undefined; }, setAlarm: async (value) => { alarm = value; } };
	try {
		globalThis.fetch = async () => Response.json({ id: 'cs_new', status: 'complete', payment_status: status });
		const watcher = new RankCheckoutExpiry({ storage }, { DB: f.DB, STRIPE_SECRET_KEY: 'test-only' });
		await watcher.fetch(new Request('https://rank-checkout.internal/watch', { method: 'POST', body: JSON.stringify({ sessionId: 'cs_new', bidId: 1, deadline: Date.now() - 1 }) }));
		await watcher.alarm();
		assert.equal(f.status(1), 'pending');
		assert.ok(record);
		assert.ok(alarm > Date.now());
		status = 'paid';
		await watcher.alarm();
		assert.equal(f.status(1), 'paid');
		assert.equal(record, undefined);
	} finally { globalThis.fetch = network; f.sqlite.close(); }
});

test('rank alarm expires an open Checkout at its deadline and releases only the unpaid bid', async () => {
	const f = fixture();
	const network = globalThis.fetch;
	let record = { sessionId: 'cs_new', bidId: 1, deadline: Date.now() - 1 };
	const storage = { get: async () => record, delete: async () => { record = undefined; }, setAlarm: async () => {} };
	let expired = false;
	try {
		globalThis.fetch = async (_, options) => { if (options?.method === 'POST') expired = true; return Response.json({ id: 'cs_new', status: expired ? 'expired' : 'open', payment_status: 'unpaid' }); };
		await new RankCheckoutExpiry({ storage }, { DB: f.DB, STRIPE_SECRET_KEY: 'test-only' }).alarm();
		assert.equal(expired, true);
		assert.equal(f.status(1), 'expired');
		assert.equal(f.status(2), 'paid');
		assert.equal(record, undefined);
	} finally { globalThis.fetch = network; f.sqlite.close(); }
});
