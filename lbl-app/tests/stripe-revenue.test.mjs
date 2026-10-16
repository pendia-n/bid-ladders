import assert from 'node:assert/strict';
import test from 'node:test';
import { scanStripeRevenue } from '../src/lib/server/stripe-revenue.ts';

const timestamp = Date.parse('2026-10-17T00:00:00Z');
const paidAt = timestamp / 1000 - 86400;
const product = { id: 'prod_shared', name: 'Subscription' };
const price = { id: 'price_inline', product: product.id, currency: 'usd', unit_amount: 1000, recurring: { interval: 'month' } };
const line = (extra = {}) => ({ price, currency: 'usd', amount: 1000, amount_total: 1000, quantity: 1, ...extra });
const subscription = (subscriptionId, extra = {}) => ({ id: subscriptionId, status: 'active', customer: `cus_${subscriptionId}`, items: { data: [line()] }, ...extra });
const invoice = (invoiceId, subscriptionId, extra = {}) => ({ id: invoiceId, subscription: subscriptionId, status: 'paid', currency: 'usd', created: paidAt, lines: { data: [line()] }, ...extra });
const checkout = (sessionId, extra = {}) => ({ id: sessionId, mode: 'payment', status: 'complete', payment_status: 'paid', created: paidAt, line_items: { data: [line()] }, ...extra });

function fixture({ products = [product], prices = [], subscriptions = [], invoices = [], sessions = [], routes = {}, denied = [] } = {}) {
	const calls = [];
	const reader = {
		async list(path, params = {}) {
			calls.push(path);
			if (denied.includes(path)) throw new Error('Permission denied');
			if (path in routes) return routes[path];
			if (path === 'products') return params.active === 'false' ? [] : products;
			if (path === 'prices') return params.active === 'false' ? [] : prices;
			if (path === 'subscriptions') return subscriptions;
			if (path === 'invoices') return invoices;
			if (path === 'checkout/sessions') return sessions;
			throw new Error(`Unexpected list: ${path}`);
		},
		async get(path) {
			calls.push(path);
			if (path in routes) return routes[path];
			throw new Error(`Unexpected get: ${path}`);
		}
	};
	return { calls, scan: (name = 'Fable Maker') => scanStripeRevenue(name, reader, timestamp) };
}

test('retains all 21 Prices under named product families and normalizes recurring amounts', async () => {
	const named = { id: 'prod_fable', name: 'FableMaker - Solo' };
	const prices = Array.from({ length: 21 }, (_, index) => ({ ...price, id: `price_${index}`, product: named.id }));
	const f = fixture({ products: [named], prices, subscriptions: [subscription('sub_fable', { items: { data: [line({ price: prices[0], quantity: 2 }), line({ price: { ...prices[1], unit_amount: 12000, recurring: { interval: 'year' } } })] } })] });
	const result = await f.scan();
	assert.equal(result.family.prices.length, 21);
	assert.equal(result.metrics.mrr.cents, 3000);
	assert.equal(result.metrics.totalRevenue, 0);
});

test('discovers a one-time inline Checkout by name without catalog Prices', async () => {
	const result = await fixture({ sessions: [checkout('cs_inline', { line_items: { data: [line({ description: 'Fable Maker credits', price: { ...price, recurring: null } })] } })] }).scan();
	assert.deepEqual(result.family.prices.map((item) => item.id), [price.id]);
	assert.equal(result.metrics.totalRevenue, 1000);
	assert.equal(result.metrics.mrr.cents, 0);
});

test('Checkout subscription discovery includes renewals without counting the initial Checkout twice', async () => {
	const modern = { currency: 'usd', amount: 1000, pricing: { price_details: { price: price.id, product: product.id } } };
	const f = fixture({ subscriptions: [subscription('sub_fable'), subscription('sub_other')], invoices: [invoice('in_first', 'sub_fable', { lines: { data: [modern] } }), invoice('in_renewal', 'sub_fable'), invoice('in_other', 'sub_other')], sessions: [checkout('cs_sub', { mode: 'subscription', subscription: 'sub_fable', metadata: { app_name: 'Fable Maker' } })] });
	const result = await f.scan();
	assert.equal(result.metrics.mrr.cents, 1000);
	assert.equal(result.metrics.activeCustomers, 1);
	assert.equal(result.metrics.totalRevenue, 2000);
	assert.equal(result.metrics.last30dRevenue, 2000);
});

test('a name on one Checkout does not claim another app using the same Product and Price', async () => {
	const result = await fixture({ sessions: [checkout('cs_fable', { metadata: { app: 'Fable Maker' } }), checkout('cs_other', { metadata: { app: 'Online Kisser' } })] }).scan();
	assert.equal(result.metrics.totalRevenue, 1000);
});

test('matches a free-form invoice description without requiring Product or Price IDs', async () => {
	const result = await fixture({ products: [], invoices: [invoice('in_freeform', null, { description: 'Fable Maker consulting', lines: { data: [{ amount: 4500, currency: 'usd' }] } })] }).scan();
	assert.ok(result.family);
	assert.deepEqual(result.family.productIds, []);
	assert.deepEqual(result.family.prices, []);
	assert.equal(result.metrics.totalRevenue, 4500);
});

test('mixed baskets count matching lines and exclude ambiguous document-only matches', async () => {
	const result = await fixture({ sessions: [checkout('cs_mixed', { metadata: { app: 'Fable Maker' }, line_items: { data: [line({ description: 'Fable Maker credits' }), line({ description: 'Online Kisser credits', amount_total: 9000 })] } })] }).scan();
	assert.equal(result.metrics.totalRevenue, 1000);
	assert.ok(result.metrics.warnings.some((warning) => warning.includes('Unmatched lines')));
});

test('an invoiced one-time Checkout is counted once using the paid invoice timestamp', async () => {
	const result = await fixture({ invoices: [invoice('in_checkout', null, { created: paidAt - 100 * 86400, status_transitions: { paid_at: paidAt } })], sessions: [checkout('cs_payment', { invoice: 'in_checkout', metadata: { app: 'Fable Maker' } })] }).scan();
	assert.equal(result.metrics.totalRevenue, 1000);
	assert.equal(result.metrics.last30dRevenue, 1000);
});

test('invoice line names discover the corresponding recurring subscription and its other invoices', async () => {
	const result = await fixture({ subscriptions: [subscription('sub_fable'), subscription('sub_other')], invoices: [invoice('in_named', 'sub_fable', { lines: { data: [line({ description: 'Fable Maker subscription' })] } }), invoice('in_renewal', 'sub_fable'), invoice('in_other', 'sub_other')] }).scan();
	assert.equal(result.metrics.mrr.cents, 1000);
	assert.equal(result.metrics.totalRevenue, 2000);
});

test('missing Invoice and Checkout permissions surface warnings and unavailable revenue', async () => {
	const named = { ...product, name: 'Fable Maker' };
	const result = await fixture({ products: [named], prices: [price], subscriptions: [subscription('sub_fable')], denied: ['invoices', 'checkout/sessions'] }).scan();
	assert.equal(result.metrics.mrr.cents, 1000);
	assert.equal(result.metrics.revenueAvailable, false);
	assert.equal(result.metrics.totalRevenue, null);
	assert.equal(result.metrics.warnings.length, 2);
});

test('reads paginated Invoice and subscription items and resolves modern inline Price references', async () => {
	const f = fixture({ subscriptions: [subscription('sub_fable', { metadata: { app: 'Fable Maker' }, items: { data: [], has_more: true } })], invoices: [invoice('in_pages', 'sub_fable', { lines: { data: [], has_more: true } })], routes: { subscription_items: [line()], 'invoices/in_pages/lines': [{ pricing: { price_details: { price: 'price_second', product: product.id } }, description: 'Fable Maker credits', amount: 2500, currency: 'usd' }], 'prices/price_second': { ...price, id: 'price_second', recurring: null } } });
	const result = await f.scan();
	assert.equal(result.metrics.mrr.cents, 1000);
	assert.equal(result.metrics.totalRevenue, 2500);
	assert.ok(f.calls.includes('subscription_items'));
	assert.ok(f.calls.includes('prices/price_second'));
});

test('never combines matched amounts from different currencies', async () => {
	await assert.rejects(fixture({ sessions: [checkout('cs_usd', { metadata: { app: 'Fable Maker' } }), checkout('cs_eur', { metadata: { app: 'Fable Maker' }, line_items: { data: [line({ currency: 'eur' })] } })] }).scan(), /multiple currencies/);
});

test('does not publish partial revenue when only one history source is readable', async () => {
	const result = await fixture({ sessions: [checkout('cs_named', { metadata: { app: 'Fable Maker' } })], denied: ['invoices'] }).scan();
	assert.ok(result.family);
	assert.equal(result.metrics.revenueAvailable, false);
	assert.equal(result.metrics.totalRevenue, null);
});

test('recognizes compact names in Invoice custom fields', async () => {
	const result = await fixture({ invoices: [invoice('in_custom', null, { custom_fields: [{ name: 'App', value: 'fablemaker' }] })] }).scan();
	assert.equal(result.metrics.totalRevenue, 1000);
});

test('fails verification rather than silently omitting unreadable subscription items', async () => {
	await assert.rejects(fixture({ subscriptions: [subscription('sub_pages', { items: { data: [], has_more: true } })], denied: ['subscription_items'] }).scan(), /Subscription items could not be read/);
});
