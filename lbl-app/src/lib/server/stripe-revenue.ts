type StripeObject = Record<string, any>;
export type StripeReader = {
	list(path: string, params?: Record<string, string>): Promise<StripeObject[]>;
	get(path: string): Promise<StripeObject>;
};

type EvidenceLine = { raw: StripeObject; price: StripeObject; product: StripeObject; subscriptionId: string };
type Evidence = { kind: 'subscription' | 'invoice' | 'checkout'; record: StripeObject; lines: EvidenceLine[]; named: boolean };

function id(value: any): string { return typeof value === 'string' ? value : String(value?.id || ''); }
function tokens(value: unknown): string[] { return String(value || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }
function matchesName(name: string, values: unknown[]): boolean {
	const target = tokens(name);
	const text = new Set(values.flatMap(tokens));
	return target.length > 0 && (target.every((token) => text.has(token)) || (target.length > 1 && values.some((value) => tokens(value).join('').includes(target.join('')))));
}
function text(object: StripeObject): unknown[] {
	return [object.name, object.description, object.nickname, object.lookup_key, JSON.stringify(object.metadata || {})];
}
function subscriptionId(record: StripeObject): string {
	return id(record.subscription || record.parent?.subscription_details?.subscription);
}
function scoped(subscription: string, price: string): string { return `${subscription}:${price}`; }

export async function scanStripeRevenue(name: string, reader: StripeReader, timestamp = Date.now()) {
	const warnings = new Set<string>();
	const optionalList = async (path: string, params: Record<string, string>, warning: string) => {
		try { return await reader.list(path, params); }
		catch { warnings.add(warning); return null; }
	};
	const [activeProducts, archivedProducts, activePrices, archivedPrices, subscriptions, invoices, sessions] = await Promise.all([
		reader.list('products', { active: 'true' }), reader.list('products', { active: 'false' }),
		reader.list('prices', { active: 'true' }), reader.list('prices', { active: 'false' }),
		reader.list('subscriptions', { status: 'all' }),
		optionalList('invoices', { status: 'paid' }, 'Invoice history could not be read. Enable Invoices: Read and retry.'),
		optionalList('checkout/sessions', { status: 'complete' }, 'Checkout history could not be read. Enable Checkout Sessions: Read and retry.')
	]);
	const products = new Map([...activeProducts, ...archivedProducts].map((item) => [id(item), item]));
	const prices = new Map([...activePrices, ...archivedPrices].map((item) => [id(item), item]));
	const namedProducts = new Set([...products.values()].filter((item) => matchesName(name, text(item))).map(id));
	const namedPrices = new Set([...prices.values()].filter((item) => namedProducts.has(id(item.product)) || matchesName(name, text(item))).map(id));
	const resolve = async (value: any, collection: Map<string, StripeObject>, resource: string): Promise<StripeObject> => {
		if (value && typeof value === 'object' && !value.deleted) { collection.set(id(value), value); return value; }
		const objectId = id(value);
		if (!objectId) return {};
		if (collection.has(objectId)) return collection.get(objectId)!;
		try { const object = await reader.get(`${resource}/${encodeURIComponent(objectId)}`); collection.set(objectId, object); return object; }
		catch { warnings.add('Some linked Stripe pricing records could not be read; matching may be incomplete.'); return { id: objectId }; }
	};
	const evidence: Evidence[] = [];
	const collect = async (kind: Evidence['kind'], record: StripeObject) => {
		const embedded = kind === 'subscription' ? record.items : kind === 'invoice' ? record.lines : record.line_items;
		let lines: StripeObject[];
		try {
			if (embedded?.data && !embedded.has_more) lines = embedded.data;
			else if (kind === 'subscription') lines = await reader.list('subscription_items', { subscription: id(record) });
			else lines = await reader.list(kind === 'invoice' ? `invoices/${encodeURIComponent(id(record))}/lines` : `checkout/sessions/${encodeURIComponent(id(record))}/line_items`);
		} catch {
			if (kind === 'subscription') throw new Error('Subscription items could not be read. Check Subscriptions: Read and retry.');
			warnings.add(`Some ${kind} line items could not be read; matching may be incomplete.`);
			return;
		}
		const normalized: EvidenceLine[] = [];
		for (const raw of lines) {
			const price = await resolve(raw.price || raw.plan || raw.pricing?.price_details?.price, prices, 'prices');
			const product = await resolve(price.product || raw.pricing?.price_details?.product, products, 'products');
			if (matchesName(name, text(product))) namedProducts.add(id(product));
			if (matchesName(name, text(price))) namedPrices.add(id(price));
			normalized.push({ raw, price, product, subscriptionId: kind === 'subscription' ? id(record) : id(raw.subscription || raw.parent?.subscription_item_details?.subscription || raw.parent?.invoice_item_details?.subscription) || subscriptionId(record) });
		}
		evidence.push({ kind, record, lines: normalized, named: matchesName(name, [...text(record), record.client_reference_id, record.footer, record.statement_descriptor, JSON.stringify(record.custom_fields || []), JSON.stringify(record.custom_text || {}), JSON.stringify(record.parent?.subscription_details?.metadata || {}), JSON.stringify(record.subscription_details?.metadata || {})]) });
	};
	for (const subscription of subscriptions) await collect('subscription', subscription);
	for (const invoice of invoices || []) await collect('invoice', invoice);
	for (const session of sessions || []) await collect('checkout', session);

	const baseMatch = (line: EvidenceLine, group: Evidence) => namedProducts.has(id(line.product)) || namedPrices.has(id(line.price)) || matchesName(name, text(line.raw)) || (group.lines.length === 1 && group.named);
	// A name on one invoice/Checkout must not claim a shared Product's other sales.
	const subscriptionPrices = new Set<string>();
	for (const group of evidence) for (const line of group.lines) {
		if (baseMatch(line, group) && line.subscriptionId && id(line.price)) subscriptionPrices.add(scoped(line.subscriptionId, id(line.price)));
	}
	const subscriptionMatch = (line: EvidenceLine, group: Evidence) => baseMatch(line, group) || (!!line.subscriptionId && !!id(line.price) && subscriptionPrices.has(scoped(line.subscriptionId, id(line.price))));
	const invoicePrices = new Set<string>();
	const namedSingleInvoices = new Set<string>();
	for (const group of evidence.filter((item) => item.kind === 'checkout')) {
		const invoice = id(group.record.invoice);
		if (!invoice) continue;
		for (const line of group.lines) if (subscriptionMatch(line, group) && id(line.price)) invoicePrices.add(scoped(invoice, id(line.price)));
		if (group.lines.length > 0 && group.lines.every((line) => subscriptionMatch(line, group))) namedSingleInvoices.add(invoice);
	}
	const selected = (line: EvidenceLine, group: Evidence) => subscriptionMatch(line, group) || (group.kind === 'invoice' && ((!!id(line.price) && invoicePrices.has(scoped(id(group.record), id(line.price)))) || (group.lines.length === 1 && namedSingleInvoices.has(id(group.record)))));
	const selectedProducts = new Set(namedProducts);
	const selectedPrices = new Set(namedPrices);
	let matchedRecords = 0;
	for (const group of evidence) {
		const matched = group.lines.filter((line) => selected(line, group));
		if (matched.length) matchedRecords++;
		if (group.named && group.lines.length > 1 && matched.length !== group.lines.length) warnings.add('Some multi-item records name this app only at document level. Unmatched lines were excluded.');
		for (const line of matched) {
			if (id(line.product)) selectedProducts.add(id(line.product));
			if (id(line.price)) selectedPrices.add(id(line.price));
		}
	}
	// Include every catalog Price under independently named Products, plus discovered inline Prices.
	for (const price of prices.values()) {
		if (namedProducts.has(id(price.product))) selectedPrices.add(id(price));
		if (selectedPrices.has(id(price)) && id(price.product)) selectedProducts.add(id(price.product));
	}
	const currencies = new Set<string>();
	const observeCurrency = (currency: unknown) => { if (currency) currencies.add(String(currency)); };
	let mrr = 0;
	const customers = new Set<string>();
	for (const group of evidence.filter((item) => item.kind === 'subscription')) {
		if (!['active', 'trialing', 'past_due'].includes(group.record.status)) continue;
		for (const line of group.lines.filter((item) => selected(item, group))) {
			const recurring = line.price.recurring;
			if (id(group.record.customer)) customers.add(id(group.record.customer));
			if (!recurring) continue;
			if (line.price.billing_scheme === 'tiered' || recurring.usage_type === 'metered') { warnings.add('Usage-based or tiered subscriptions are excluded from fixed-price MRR.'); continue; }
			const amount = Number(line.price.unit_amount ?? line.price.unit_amount_decimal ?? 0);
			const interval = Number(recurring.interval_count || 1);
			const multiplier = recurring.interval === 'year' ? 1 / (12 * interval) : recurring.interval === 'week' ? 52 / (12 * interval) : recurring.interval === 'day' ? 365 / (12 * interval) : 1 / interval;
			observeCurrency(line.price.currency);
			mrr += amount * Number(line.raw.quantity ?? 1) * multiplier;
		}
	}
	let totalRevenue = 0;
	let last30dRevenue = 0;
	const dailyRevenue = new Map<string, number>();
	const cutoff = Math.floor((timestamp - 30 * 24 * 60 * 60 * 1000) / 1000);
	const add = (amount: number, at: number, currency: unknown) => {
		if (!Number.isFinite(amount) || !Number.isFinite(at) || at <= 0) return;
		observeCurrency(currency);
		totalRevenue += amount;
		if (at >= cutoff) {
			last30dRevenue += amount;
			const day = new Date(at * 1000).toISOString().slice(0, 10);
			dailyRevenue.set(day, (dailyRevenue.get(day) || 0) + amount);
		}
	};
	const countedInvoices = new Set<string>();
	for (const group of evidence.filter((item) => item.kind === 'invoice')) {
		const matched = group.lines.filter((line) => selected(line, group));
		if (!matched.length) continue;
		countedInvoices.add(id(group.record));
		for (const { raw } of matched) {
			const discounts = (raw.discount_amounts || []).reduce((sum: number, discount: StripeObject) => sum + Number(discount.amount || 0), 0);
			add(Number(raw.amount || 0) - discounts, Number(group.record.status_transitions?.paid_at || group.record.created), raw.currency || group.record.currency);
		}
	}
	for (const group of evidence.filter((item) => item.kind === 'checkout')) {
		const session = group.record;
		// Subscription payments come from invoices; invoiced one-time Checkout is counted once.
		if (session.mode !== 'payment' || session.payment_status !== 'paid' || countedInvoices.has(id(session.invoice))) continue;
		for (const { raw } of group.lines.filter((line) => selected(line, group))) add(Number(raw.amount_total ?? raw.amount_subtotal ?? raw.amount ?? 0), Number(session.created), raw.currency || session.currency);
	}
	if (currencies.size > 1) throw new Error('Matched Stripe records use multiple currencies. They cannot be combined into one revenue total.');
	const currency = [...currencies][0] || 'usd';
	const revenueAvailable = invoices !== null && sessions !== null && ![...warnings].some((warning) => warning.includes('could not be read'));
	const family = selectedProducts.size || selectedPrices.size || matchedRecords ? {
		id: 'stripe-family', name: name.trim(), productIds: [...selectedProducts],
		productNames: [...selectedProducts].map((productId) => String(products.get(productId)?.name || 'Unnamed Stripe Product')),
		prices: [...selectedPrices].map((priceId) => { const price = prices.get(priceId) || {}; return { id: priceId, active: price.active, unit_amount: price.unit_amount, currency: price.currency, recurring: price.recurring }; }),
		matchedRecords, warnings: [...warnings]
	} : null;
	return { family, metrics: { mrr: { cents: Math.round(mrr), currency }, totalRevenue: revenueAvailable ? Math.round(totalRevenue) : null, last30dRevenue: revenueAvailable ? Math.round(last30dRevenue) : null, revenueDaily: [...dailyRevenue.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, cents]) => ({ date, cents })), activeCustomers: customers.size, currency, revenueAvailable, warnings: [...warnings] } };
}
