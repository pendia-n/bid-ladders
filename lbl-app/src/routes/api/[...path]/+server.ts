import type { RequestEvent } from '@sveltejs/kit';
import { encryptText, verifyTotp } from '$lib/server/crypto';
import { envFrom, getDb, loginUser, registerUser, requireUser, userFromToken, verifyUserTotp, type AuthUser } from '$lib/server/auth';

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const now = () => new Date().toISOString();
const asCents = (value: unknown) => Math.max(0, Math.round(Number(value || 0) * 100));

async function body(event: RequestEvent): Promise<Record<string, any>> {
	try { return await event.request.json(); } catch { return {}; }
}

function forbiddenRole(user: AuthUser, role: AuthUser['role']): Response | null {
	return user.role === role ? null : json({ error: `${role} access required` }, 403);
}

async function audit(event: RequestEvent, actorId: number | null, eventType: string, entityType: string, entityId: string, detail: Record<string, unknown> = {}) {
	await getDb(event).prepare('INSERT INTO audit_events (actor_id, event_type, entity_type, entity_id, detail_json) VALUES (?, ?, ?, ?, ?)').bind(actorId, eventType, entityType, entityId, JSON.stringify(detail)).run();
}

function stripeHeaders(key: string) { return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' }; }

async function stripeGet(key: string, path: string) {
	const response = await fetch(`https://api.stripe.com/v1/${path}`, { headers: { Authorization: `Bearer ${key}` } });
	const data = await response.json() as any;
	if (!response.ok) throw new Error(data?.error?.message || 'Stripe request failed');
	return data;
}

async function stripePost(key: string, path: string, params: URLSearchParams) {
	const response = await fetch(`https://api.stripe.com/v1/${path}`, { method: 'POST', headers: stripeHeaders(key), body: params.toString() });
	const data = await response.json() as any;
	if (!response.ok) throw new Error(data?.error?.message || 'Stripe request failed');
	return data;
}

function normalized(value: string) { return value.trim().toLowerCase().replace(/\s+/g, ' '); }

type ListingRow = { id: number; seller_id: number; product_url: string; name: string; summary: string; description: string | null; asking_price_cents: number; mrr_cents: number; mrr_status: string; verified_at: string | null; operating_cost_cents: number; assets_included: string; created_at: string; seller_username: string };
type BidRow = { id: number; listing_id: number; amount_cents: number; paid_at: string; expires_at: string };

async function loadRankedListings(event: RequestEvent, query = '') {
	const db = getDb(event);
	const search = normalized(query);
	const filter = search ? 'AND (LOWER(l.name) LIKE ? OR LOWER(l.summary) LIKE ?)' : '';
	const args = search ? [`%${search}%`, `%${search}%`] : [];
	const listingRows = await db.prepare(`SELECT l.id, l.seller_id, l.product_url, l.name, l.summary, l.description, l.asking_price_cents, l.mrr_cents, l.mrr_status, l.verified_at, l.operating_cost_cents, l.assets_included, l.created_at, u.username AS seller_username FROM listings l JOIN users u ON u.id = l.seller_id WHERE l.status = 'published' ${filter}`).bind(...args).all<ListingRow>();
	const bidRows = await db.prepare(`SELECT id, listing_id, amount_cents, paid_at, expires_at FROM bids WHERE status = 'paid' AND expires_at > ? ORDER BY amount_cents DESC, paid_at ASC, id ASC`).bind(now()).all<BidRow>();
	const bestBid = new Map<number, BidRow>();
	for (const bid of bidRows.results ?? []) if (!bestBid.has(bid.listing_id)) bestBid.set(bid.listing_id, bid);
	const paid = (listingRows.results ?? []).filter((listing: ListingRow) => bestBid.has(listing.id)).sort((a: ListingRow, b: ListingRow) => {
		const left = bestBid.get(a.id)!; const right = bestBid.get(b.id)!;
		return right.amount_cents - left.amount_cents || String(left.paid_at).localeCompare(String(right.paid_at)) || a.id - b.id;
	});
	const free = (listingRows.results ?? []).filter((listing: ListingRow) => !bestBid.has(listing.id)).sort((a: ListingRow, b: ListingRow) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id);
	return [...paid, ...free].map((listing, index) => ({
		...listing,
		mrr: Number(listing.mrr_cents || 0) / 100,
		asking_price: Number(listing.asking_price_cents || 0) / 100,
		operating_cost: Number(listing.operating_cost_cents || 0) / 100,
		paid_bid: bestBid.has(listing.id) ? Number(bestBid.get(listing.id)!.amount_cents) / 100 : null,
		rank: index + 1,
		visible_on_home: index < 330,
		is_sponsored: bestBid.has(listing.id)
	}));
}

async function verifyStripeSignature(bodyText: string, signature: string, secret: string) {
	const pieces = signature.split(',');
	const timestamp = pieces.find((piece) => piece.startsWith('t='))?.slice(2);
	const signatures = pieces.filter((piece) => piece.startsWith('v1=')).map((piece) => piece.slice(3));
	if (!timestamp || !signatures.length || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${bodyText}`)));
	const expected = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
	return signatures.some((value) => value === expected);
}

async function matchingStripeProducts(key: string, name: string) {
	const products = await stripeGet(key, 'products?active=true&limit=100');
	const target = normalized(name);
	return Promise.all((products.data ?? []).filter((product: any) => normalized(product.name).includes(target) || target.includes(normalized(product.name))).slice(0, 10).map(async (product: any) => {
		const prices = await stripeGet(key, `prices?active=true&product=${encodeURIComponent(product.id)}&limit=100`);
		return { id: product.id, name: product.name, description: product.description, prices: (prices.data ?? []).map((price: any) => ({ id: price.id, unit_amount: price.unit_amount, currency: price.currency, recurring: price.recurring })) };
	}));
}

async function calculateMrr(key: string, priceIds: string[]) {
	const subscriptions = await stripeGet(key, 'subscriptions?status=all&limit=100');
	let total = 0; let currency = 'usd';
	for (const subscription of subscriptions.data ?? []) {
		if (!['active', 'trialing', 'past_due'].includes(subscription.status)) continue;
		for (const item of subscription.items?.data ?? []) {
			if (!priceIds.includes(item.price?.id)) continue;
			const recurring = item.price?.recurring;
			const amount = Number(item.price?.unit_amount ?? item.price?.unit_amount_decimal ?? 0);
			if (!recurring || !amount) continue;
			currency = item.price.currency || currency;
			const multiplier = recurring.interval === 'year' ? 1 / (12 * Number(recurring.interval_count || 1)) : recurring.interval === 'week' ? 52 / 12 / Number(recurring.interval_count || 1) : recurring.interval === 'day' ? 365 / 12 / Number(recurring.interval_count || 1) : 1 / Number(recurring.interval_count || 1);
			total += amount * Number(item.quantity || 1) * multiplier;
		}
	}
	return { cents: Math.round(total), currency };
}

async function handle(event: RequestEvent): Promise<Response> {
	const route = event.url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
	const segments = route ? route.split('/') : [];
	const method = event.request.method;

	if (route === 'health') return json({ ok: true, app: 'lbl-app', database: !!envFrom(event).DB, time: now() });

	if (route === 'auth/signup' && method === 'POST') {
		const input = await body(event);
		if (!['seller', 'buyer'].includes(input.role)) return json({ error: 'Choose seller or buyer' }, 400);
		try { return json(await registerUser(event, String(input.username || ''), String(input.password || ''), input.role)); }
		catch (error: any) { return json({ error: String(error?.message || '').includes('UNIQUE') ? 'Username is already taken' : error?.message || 'Unable to create account' }, String(error?.message || '').includes('UNIQUE') ? 409 : 400); }
	}

	if (route === 'auth/login' && method === 'POST') {
		const input = await body(event);
		try { return json(await loginUser(event, String(input.username || ''), String(input.password || ''))); }
		catch (error: any) { return json({ error: error?.message || 'Invalid username or password' }, 401); }
	}

	if (route === 'auth/me' && method === 'GET') {
		const user = await userFromToken(event);
		return user ? json({ user }) : json({ user: null }, 401);
	}

	if (route === 'auth/totp/setup' && method === 'POST') {
		const user = await requireUser(event);
		const secret = (await import('$lib/server/crypto')).toBase32(crypto.getRandomValues(new Uint8Array(20)));
		await getDb(event).prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').bind(secret, user.id).run();
		return json({ secret, otpauth: `otpauth://totp/BidLadders:${encodeURIComponent(user.username)}?secret=${secret}&issuer=BidLadders` });
	}

	if (route === 'auth/totp/enable' && method === 'POST') {
		const user = await requireUser(event); const input = await body(event);
		const record = await getDb(event).prepare('SELECT totp_secret FROM users WHERE id = ?').bind(user.id).first<{ totp_secret: string | null }>();
		if (!record?.totp_secret || !(await verifyTotp(record.totp_secret, String(input.code || '')))) return json({ error: 'Invalid TOTP code' }, 400);
		await getDb(event).prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').bind(user.id).run();
		return json({ ok: true });
	}

	if (route === 'auth/password/reset' && method === 'POST') {
		const user = await requireUser(event); const input = await body(event);
		if (!user.totp_enabled) return json({ error: 'Password reset requires TOTP to be enabled' }, 400);
		if (!(await verifyUserTotp(event, user, String(input.code || '')))) return json({ error: 'Valid TOTP code required' }, 400);
		const password = String(input.password || '');
		if (password.length < 12 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) return json({ error: 'Password must be 12+ characters with upper, lower, and number characters' }, 400);
		const { hashPassword } = await import('$lib/server/crypto'); const data = await hashPassword(password);
		await getDb(event).prepare('UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ? WHERE id = ?').bind(data.hash, data.salt, data.iterations, user.id).run();
		return json({ ok: true });
	}

	if (route === 'onboarding/buyer' && method === 'POST') {
		const user = await requireUser(event); const roleError = forbiddenRole(user, 'buyer'); if (roleError) return roleError; const input = await body(event);
		const required = ['legalName', 'roleTitle', 'country', 'timezone', 'budgetRange', 'purchaseEntity'];
		if (required.some((key) => !String(input[key] || '').trim()) || !['personal', 'company'].includes(input.purchaseEntity)) return json({ error: 'Complete every buyer profile field' }, 400);
		await getDb(event).prepare('INSERT INTO buyer_profiles (user_id, legal_name, company_name, role_title, country, timezone, budget_range, purchase_entity, terms_accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET legal_name=excluded.legal_name, company_name=excluded.company_name, role_title=excluded.role_title, country=excluded.country, timezone=excluded.timezone, budget_range=excluded.budget_range, purchase_entity=excluded.purchase_entity, terms_accepted_at=excluded.terms_accepted_at').bind(user.id, input.legalName, input.companyName || null, input.roleTitle, input.country, input.timezone, input.budgetRange, input.purchaseEntity, now()).run();
		return json({ ok: true });
	}

	if (route === 'listings' && method === 'GET') {
		try { return json({ listings: await loadRankedListings(event, event.url.searchParams.get('q') || '') }); }
		catch (error: any) { return json({ error: error?.message || 'Database unavailable', listings: [] }, 503); }
	}

	if (route === 'listings' && method === 'POST') {
		const user = await requireUser(event); const roleError = forbiddenRole(user, 'seller'); if (roleError) return roleError; const input = await body(event);
		const name = String(input.name || '').trim(); const summary = String(input.summary || '').trim(); const description = String(input.description || '').trim(); const mrrStatus = ['unknown', 'zero', 'verified'].includes(input.mrrStatus) ? input.mrrStatus : 'unknown';
		if (!name || !summary || !input.productUrl || !input.assetsIncluded) return json({ error: 'Product URL, name, summary, and assets included are required' }, 400);
		if (mrrStatus === 'zero' && description.length < 60) return json({ error: 'A $0 MRR listing needs a detailed description of at least 60 characters' }, 400);
		const result = await getDb(event).prepare('INSERT INTO listings (seller_id, product_url, name, summary, description, asking_price_cents, mrr_status, operating_cost_cents, assets_included, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(user.id, input.productUrl, name, summary, description || null, asCents(input.askingPrice), mrrStatus, asCents(input.operatingCost), input.assetsIncluded, input.publish ? 'published' : 'draft').run();
		await audit(event, user.id, 'listing.created', 'listing', String(result.meta.last_row_id), { status: input.publish ? 'published' : 'draft' });
		return json({ id: result.meta.last_row_id });
	}

	if (segments[0] === 'stripe' && segments[1] === 'search' && method === 'POST') {
		const user = await requireUser(event); const roleError = forbiddenRole(user, 'seller'); if (roleError) return roleError; const input = await body(event); const key = String(input.stripeKey || '');
		if (!/^rk_(test|live)_/.test(key)) return json({ error: 'Use a Stripe restricted read-only key beginning with rk_test_ or rk_live_' }, 400);
		try { return json({ products: await matchingStripeProducts(key, String(input.name || '')) }); } catch (error: any) { return json({ error: error?.message || 'Stripe search failed' }, 400); }
	}

	if (segments[0] === 'listings' && segments[2] === 'verify' && method === 'POST') {
		const user = await requireUser(event); const roleError = forbiddenRole(user, 'seller'); if (roleError) return roleError; const listingId = Number(segments[1]);
		const listing = await getDb(event).prepare('SELECT id, name FROM listings WHERE id = ? AND seller_id = ?').bind(listingId, user.id).first<{ id: number; name: string }>();
		if (!listing) return json({ error: 'Listing not found' }, 404);
		const input = await body(event); const key = String(input.stripeKey || ''); const productId = String(input.productId || ''); const priceIds = Array.isArray(input.priceIds) ? input.priceIds.map(String) : [];
		if (!/^rk_(test|live)_/.test(key) || !/^prod_/.test(productId) || !priceIds.length) return json({ error: 'Confirm a Stripe Product and at least one Price' }, 400);
		try {
			const mrr = await calculateMrr(key, priceIds); const secret = envFrom(event).ENCRYPTION_KEY || envFrom(event).JWT_SECRET || 'local-development-only-change-me'; const encrypted = await encryptText(key, secret);
			await getDb(event).prepare('INSERT INTO stripe_connections (seller_id, encrypted_key, last_verified_at) VALUES (?, ?, ?) ON CONFLICT(seller_id) DO UPDATE SET encrypted_key=excluded.encrypted_key, last_verified_at=excluded.last_verified_at').bind(user.id, encrypted, now()).run();
			await getDb(event).prepare('INSERT INTO stripe_product_mappings (listing_id, stripe_product_id, stripe_price_ids, product_name) VALUES (?, ?, ?, ?) ON CONFLICT(listing_id) DO UPDATE SET stripe_product_id=excluded.stripe_product_id, stripe_price_ids=excluded.stripe_price_ids, product_name=excluded.product_name, updated_at=CURRENT_TIMESTAMP').bind(listingId, productId, JSON.stringify(priceIds), listing.name).run();
			await getDb(event).prepare('UPDATE listings SET mrr_cents = ?, mrr_status = ?, verified_at = ?, updated_at = ? WHERE id = ? AND seller_id = ?').bind(mrr.cents, mrr.cents === 0 ? 'zero' : 'verified', now(), now(), listingId, user.id).run();
			await getDb(event).prepare('INSERT INTO mrr_snapshots (listing_id, mrr_cents, currency, methodology) VALUES (?, ?, ?, ?)').bind(listingId, mrr.cents, mrr.currency, 'Active, trialing, and past_due subscriptions matched only to seller-confirmed Stripe Price IDs; recurring amounts normalized monthly.').run();
			await audit(event, user.id, 'listing.mrr_verified', 'listing', String(listingId), { productId, priceIds, mrrCents: mrr.cents });
			return json({ mrr: mrr.cents / 100, currency: mrr.currency, verifiedAt: now() });
		} catch (error: any) { return json({ error: error?.message || 'Stripe verification failed' }, 400); }
	}

	if (segments[0] === 'listings' && segments[2] === 'bid' && method === 'POST') {
		const user = await requireUser(event); const roleError = forbiddenRole(user, 'seller'); if (roleError) return roleError; const listingId = Number(segments[1]);
		const listing = await getDb(event).prepare("SELECT id, name, seller_id FROM listings WHERE id = ? AND seller_id = ? AND status = 'published'").bind(listingId, user.id).first<any>();
		if (!listing) return json({ error: 'Published listing not found' }, 404);
		const input = await body(event); const desiredRank = Math.max(1, Math.min(330, Number(input.desiredRank || 1)));
		const activeBids = await getDb(event).prepare("SELECT amount_cents FROM bids WHERE status = 'paid' AND expires_at > ? ORDER BY amount_cents DESC, paid_at ASC, id ASC").bind(now()).all<{ amount_cents: number }>();
		const minimum = activeBids.results?.length ? Number(activeBids.results[Math.min(desiredRank - 1, activeBids.results.length - 1)]?.amount_cents || 0) + 50 : 200; const amount = asCents(input.amount);
		if (amount < minimum) return json({ error: `Minimum bid for this position is $${(minimum / 100).toFixed(2)}`, minimum: minimum / 100 }, 400);
		const stripeKey = envFrom(event).STRIPE_SECRET_KEY; if (!stripeKey) return json({ error: 'Bid payments are not configured yet. Add STRIPE_SECRET_KEY to this Worker.' }, 503);
		const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); const pending = await getDb(event).prepare('INSERT INTO bids (listing_id, seller_id, amount_cents, expires_at) VALUES (?, ?, ?, ?)').bind(listingId, user.id, amount, expires).run();
		const session = await stripePost(stripeKey, 'checkout/sessions', new URLSearchParams({ mode: 'payment', 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][product_data][name]': `BidLadders rank boost: ${listing.name}`, 'line_items[0][price_data][unit_amount]': String(amount), 'line_items[0][quantity]': '1', success_url: `${envFrom(event).APP_URL || event.url.origin}/?bid=success`, cancel_url: `${envFrom(event).APP_URL || event.url.origin}/?bid=cancelled`, 'metadata[type]': 'rank_bid', 'metadata[bid_id]': String(pending.meta.last_row_id), 'metadata[listing_id]': String(listingId), 'metadata[desired_rank]': String(desiredRank) }));
		await getDb(event).prepare('UPDATE bids SET checkout_session_id = ? WHERE id = ?').bind(session.id, pending.meta.last_row_id).run(); return json({ url: session.url, sessionId: session.id });
	}

	if (route === 'stripe/webhook' && method === 'POST') {
		const signature = event.request.headers.get('stripe-signature'); const secret = envFrom(event).STRIPE_WEBHOOK_SECRET; const raw = await event.request.text();
		if (!signature || !secret || !(await verifyStripeSignature(raw, signature, secret))) return json({ error: 'Invalid Stripe signature' }, 401);
		const stripeEvent = JSON.parse(raw);
		if (stripeEvent.type === 'checkout.session.completed' && stripeEvent.data.object.metadata?.type === 'rank_bid') {
			const session = stripeEvent.data.object; const bidId = Number(session.metadata.bid_id); const bid = await getDb(event).prepare("SELECT id, seller_id FROM bids WHERE id = ? AND status = 'pending'").bind(bidId).first<any>();
			if (bid) { const started = now(); const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); await getDb(event).prepare("UPDATE bids SET status = 'paid', paid_at = ?, starts_at = ?, expires_at = ?, checkout_session_id = ? WHERE id = ?").bind(started, started, expires, session.id, bidId).run(); await audit(event, bid.seller_id, 'bid.paid', 'bid', String(bidId), { checkoutSessionId: session.id }); }
		}
		return json({ received: true });
	}

	if (route === 'deals' && method === 'GET') {
		const user = await requireUser(event); const result = await getDb(event).prepare('SELECT d.id, d.status, d.offer_cents, d.created_at, d.updated_at, l.id AS listing_id, l.name AS listing_name, buyer.username AS buyer_username, seller.username AS seller_username FROM deals d JOIN listings l ON l.id = d.listing_id JOIN users buyer ON buyer.id = d.buyer_id JOIN users seller ON seller.id = d.seller_id WHERE d.buyer_id = ? OR d.seller_id = ? ORDER BY d.updated_at DESC').bind(user.id, user.id).all<any>();
		return json({ deals: (result.results ?? []).map((deal: any) => ({ ...deal, offer: deal.offer_cents / 100 })) });
	}

	if (segments[0] === 'deals' && segments[1] === 'offer' && method === 'POST') {
		const user = await requireUser(event); const roleError = forbiddenRole(user, 'buyer'); if (roleError) return roleError; const input = await body(event);
		const listing = await getDb(event).prepare("SELECT id, seller_id FROM listings WHERE id = ? AND status = 'published'").bind(Number(input.listingId)).first<{ id: number; seller_id: number }>();
		if (!listing || listing.seller_id === user.id) return json({ error: 'Published listing not found' }, 404);
		const message = String(input.message || '').trim(); if (!message) return json({ error: 'Include a message with your offer' }, 400);
		const result = await getDb(event).prepare("INSERT INTO deals (listing_id, buyer_id, seller_id, offer_cents, status) VALUES (?, ?, ?, ?, 'inquiry')").bind(listing.id, user.id, listing.seller_id, asCents(input.offer)).run();
		await getDb(event).prepare('INSERT INTO messages (deal_id, sender_id, body) VALUES (?, ?, ?)').bind(result.meta.last_row_id, user.id, message).run(); await audit(event, user.id, 'deal.offer_created', 'deal', String(result.meta.last_row_id), { listingId: listing.id }); return json({ id: result.meta.last_row_id });
	}

	if (segments[0] === 'deals' && segments[1] && !segments[2] && method === 'GET') {
		const user = await requireUser(event); const deal = await getDb(event).prepare('SELECT d.*, l.name AS listing_name, l.product_url, buyer.username AS buyer_username, seller.username AS seller_username FROM deals d JOIN listings l ON l.id = d.listing_id JOIN users buyer ON buyer.id = d.buyer_id JOIN users seller ON seller.id = d.seller_id WHERE d.id = ? AND (d.buyer_id = ? OR d.seller_id = ?)').bind(Number(segments[1]), user.id, user.id).first<any>();
		return deal ? json({ deal: { ...deal, offer: deal.offer_cents / 100 } }) : json({ error: 'Deal not found' }, 404);
	}

	if (segments[0] === 'deals' && segments[1] && segments[2] === 'messages' && method === 'GET') {
		const user = await requireUser(event); const deal = await getDb(event).prepare('SELECT id FROM deals WHERE id = ? AND (buyer_id = ? OR seller_id = ?)').bind(Number(segments[1]), user.id, user.id).first(); if (!deal) return json({ error: 'Deal not found' }, 404);
		const messages = await getDb(event).prepare('SELECT m.id, m.body, m.created_at, u.username FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.deal_id = ? ORDER BY m.created_at ASC').bind(Number(segments[1])).all<any>(); return json({ messages: messages.results ?? [] });
	}

	if (segments[0] === 'deals' && segments[1] && segments[2] === 'messages' && method === 'POST') {
		const user = await requireUser(event); const deal = await getDb(event).prepare('SELECT id FROM deals WHERE id = ? AND (buyer_id = ? OR seller_id = ?)').bind(Number(segments[1]), user.id, user.id).first(); if (!deal) return json({ error: 'Deal not found' }, 404);
		const input = await body(event); const message = String(input.body || '').trim(); if (!message || message.length > 5000) return json({ error: 'Message must be 1-5000 characters' }, 400);
		await getDb(event).prepare('INSERT INTO messages (deal_id, sender_id, body) VALUES (?, ?, ?)').bind(Number(segments[1]), user.id, message).run(); await getDb(event).prepare('UPDATE deals SET updated_at = ? WHERE id = ?').bind(now(), Number(segments[1])).run(); return json({ ok: true });
	}

	return json({ error: 'Not found' }, 404);
}

async function safeHandle(event: RequestEvent) {
	try { return await handle(event); } catch (error: any) { if (error instanceof Response) return error; console.error(error); return json({ error: error?.message || 'Unexpected server error' }, 500); }
}

export const GET = safeHandle;
export const POST = safeHandle;
