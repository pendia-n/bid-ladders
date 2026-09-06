import type { RequestEvent } from '@sveltejs/kit';
import { base64UrlDecode, base64UrlEncode, decryptText, encryptText, signHs256, verifyHs256, verifyTotp } from '$lib/server/crypto';
import { envFrom, getDb, loginUser, registerUser, requireUser, userFromToken, verifyUserTotp, type AuthUser } from '$lib/server/auth';
import { createEscrowTransaction, escrowWebLink, getEscrowTransaction, platformFeeForAmount } from '$lib/server/escrow';

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const now = () => new Date().toISOString();
const asCents = (value: unknown) => Math.max(0, Math.round(Number(value || 0) * 100));
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_MEDIA_BYTES = 1 * 1024 * 1024;
const CAROUSEL_RESERVATION_MS = 35 * 60 * 1000;
const PERMANENT_BID_EXPIRY = '9999-12-31T23:59:59.999Z';
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MESSAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'application/pdf']);

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

function mediaBucket(event: RequestEvent) {
	const bucket = envFrom(event).MEDIA;
	if (!bucket) throw new Error('R2 binding MEDIA is not configured');
	return bucket;
}

function mediaUrl(key: string) { return key ? `/api/media?key=${encodeURIComponent(key)}` : '/profile.svg'; }

function extensionFor(type: string) {
	return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'application/pdf': 'pdf' } as Record<string, string>)[type] || 'bin';
}

function validateImage(file: FormDataEntryValue | null, label: string, types = IMAGE_TYPES) {
	if (!(file instanceof File) || !file.size) throw new Error(`${label} is required`);
	if (file.size > MAX_IMAGE_BYTES) throw new Error(`${label} must be 2MB or smaller`);
	if (!types.has(file.type)) throw new Error(`${label} must be ${types === IMAGE_TYPES ? 'JPEG, PNG, WebP, or GIF' : 'JPEG or PNG'}`);
	return file;
}

async function putImage(event: RequestEvent, file: File, prefix: string) {
	const key = `${prefix}/${crypto.randomUUID()}.${extensionFor(file.type)}`;
	await mediaBucket(event).put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type, cacheControl: 'public, max-age=31536000, immutable' } });
	return key;
}

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

async function stripeListAll(key: string, endpoint: string, params: Record<string, string> = {}) {
	const items: any[] = [];
	let startingAfter = '';
	for (let page = 0; page < 50; page += 1) {
		const query = new URLSearchParams({ ...params, limit: '100' });
		if (startingAfter) query.set('starting_after', startingAfter);
		const result = await stripeGet(key, `${endpoint}?${query.toString()}`);
		items.push(...(result.data || []));
		if (!result.has_more || !result.data?.length) break;
		startingAfter = String(result.data[result.data.length - 1].id || '');
		if (!startingAfter) break;
	}
	return items;
}

async function stripeInvoiceLines(key: string, invoiceId: string, expandedLines: any[] = []) {
	try { return await stripeListAll(key, `invoices/${encodeURIComponent(invoiceId)}/lines`); }
	catch { return expandedLines; }
}

async function stripeCheckoutLineItems(key: string, sessionId: string, expandedLines: any[] = []) {
	try { return await stripeListAll(key, `checkout/sessions/${encodeURIComponent(sessionId)}/line_items`); }
	catch { return expandedLines; }
}

async function stripePricesForProduct(key: string, productId: string) {
	const prices = await Promise.all(['true', 'false'].map((active) => stripeListAll(key, 'prices', { product: productId, active })));
	return Array.from(new Map(prices.flat().map((price: any) => [String(price.id), price])).values());
}

async function carouselRequest(event: RequestEvent, slotId: number, path: string, payload: Record<string, unknown> = {}) {
	const namespace = envFrom(event).CAROUSEL_SLOTS;
	if (!namespace) throw new Error('Carousel Durable Object is not configured');
	const object = namespace.get(namespace.idFromName(`slot-${slotId}`));
	const response = await object.fetch(`https://carousel.internal${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
	const data = await response.json() as any;
	if (!response.ok) throw new Error(data.error || 'Carousel slot is unavailable');
	return data;
}

function normalized(value: string) { return value.trim().toLowerCase().replace(/\s+/g, ' '); }
function searchTokens(value: unknown) { return new Set(String(value || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)); }
function tokenMatch(query: string, values: unknown[]) {
	const target = searchTokens(query);
	if (!target.size) return false;
	const haystack = new Set(values.flatMap((value) => [...searchTokens(value)]));
	return [...target].every((token) => haystack.has(token));
}
function parsedJson(value: string | null) { try { return value ? JSON.parse(value) : null; } catch { return null; } }

function verifiedEscrowStatus(transaction: Record<string, any>) {
	if (transaction.close_date) return 'complete';
	const items = Array.isArray(transaction.items) ? transaction.items : [];
	const itemStates = items.map((item: any) => item?.status || {});
	const scheduleStates = items.flatMap((item: any) => Array.isArray(item?.schedule) ? item.schedule.map((schedule: any) => schedule?.status || {}) : []);
	if (scheduleStates.some((state: any) => state.disbursed_to_beneficiary)) return 'payment_disbursed';
	if (scheduleStates.some((state: any) => state.payment_received)) return 'payment_received';
	if (itemStates.some((state: any) => state.rejected)) return 'rejected';
	if (itemStates.length && itemStates.every((state: any) => state.accepted)) return 'accepted';
	if (itemStates.some((state: any) => state.received)) return 'received';
	if (itemStates.some((state: any) => state.shipped)) return 'shipped';
	return null;
}

function publicGoogleSummary(value: string | null, provider: 'analytics' | 'search_console') {
	const data = parsedJson(value);
	if (!data) return null;
	if (provider === 'analytics') return { property: data.property, activeUsers: Number(data.activeUsers || 0), sessions: Number(data.sessions || 0), pageViews: Number(data.pageViews || 0), period: data.period || null, fetchedAt: data.fetchedAt || null };
	return { property: data.property, clicks: Number(data.clicks || 0), impressions: Number(data.impressions || 0), averagePosition: Number(data.averagePosition || 0), days: Number(data.days || 0), period: data.period || null, fetchedAt: data.fetchedAt || null };
}

function googleEncryptionSecret(event: RequestEvent) {
	const secret = envFrom(event).ENCRYPTION_KEY;
	if (!secret) throw new Error('Google connections require the ENCRYPTION_KEY Worker secret');
	return secret;
}

function googleJwtSecret(event: RequestEvent) {
	const secret = envFrom(event).JWT_SECRET;
	if (!secret) throw new Error('Google connections require the JWT_SECRET Worker secret');
	return secret;
}

function googleConfig(event: RequestEvent) {
	const env = envFrom(event);
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new Error('Google connections are not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to this Worker.');
	return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
}

async function googleState(event: RequestEvent, value: Record<string, unknown>) {
	const encoded = base64UrlEncode(JSON.stringify({ ...value, exp: Math.floor(Date.now() / 1000) + 10 * 60 }));
	return `${encoded}.${await signHs256(encoded, googleJwtSecret(event))}`;
}

async function readGoogleState(event: RequestEvent, value: string) {
	const [encoded, signature] = value.split('.');
	if (!encoded || !signature || !(await verifyHs256(encoded, signature, googleJwtSecret(event)))) throw new Error('Invalid Google connection state');
	const data = JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded))) as Record<string, any>;
	if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) throw new Error('Google connection state expired');
	return data;
}

async function googleTokenRequest(event: RequestEvent, params: URLSearchParams) {
	const config = googleConfig(event);
	params.set('client_id', config.clientId);
	params.set('client_secret', config.clientSecret);
	const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params });
	const data = await response.json() as any;
	if (!response.ok) throw new Error(data.error_description || data.error || 'Google token exchange failed');
	return data;
}

async function googleApi(accessToken: string, path: string, init: RequestInit = {}) {
	const headers = new Headers(init.headers);
	headers.set('authorization', `Bearer ${accessToken}`);
	headers.set('content-type', 'application/json');
	const response = await fetch(`https://analyticsdata.googleapis.com/v1beta/${path}`, { ...init, headers });
	const data = await response.json().catch(() => ({})) as any;
	if (!response.ok) throw new Error(data.error?.message || `Google API returned ${response.status}`);
	return data;
}

async function searchConsoleApi(accessToken: string, path: string, init: RequestInit = {}) {
	const headers = new Headers(init.headers);
	headers.set('authorization', `Bearer ${accessToken}`);
	headers.set('content-type', 'application/json');
	const response = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/${path}`, { ...init, headers });
	const data = await response.json().catch(() => ({})) as any;
	if (!response.ok) throw new Error(data.error?.message || `Search Console returned ${response.status}`);
	return data;
}

async function googleAccessToken(event: RequestEvent, refreshToken: string) {
	const data = await googleTokenRequest(event, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }));
	return String(data.access_token || '');
}

function analyticsProperty(value: string) { return value.trim().replace(/^properties\//, ''); }

async function fetchGoogleMetrics(event: RequestEvent, provider: 'analytics' | 'search_console', propertyRef: string, refreshToken: string) {
	const accessToken = await googleAccessToken(event, refreshToken);
	const endDate = new Date();
	const startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
	const formatDate = (date: Date) => date.toISOString().slice(0, 10);
	if (provider === 'analytics') {
		const property = analyticsProperty(propertyRef);
		const data = await googleApi(accessToken, `properties/${encodeURIComponent(property)}:runReport`, { method: 'POST', body: JSON.stringify({ dateRanges: [{ startDate: formatDate(startDate), endDate: formatDate(endDate) }], metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }] }) });
		const values = data.rows?.[0]?.metricValues?.map((item: any) => Number(item.value || 0)) || [];
		return { provider, property: `properties/${property}`, period: { start: formatDate(startDate), end: formatDate(endDate) }, activeUsers: values[0] || 0, sessions: values[1] || 0, pageViews: values[2] || 0, fetchedAt: now() };
	}
	const data = await searchConsoleApi(accessToken, `sites/${encodeURIComponent(propertyRef)}/searchAnalytics/query`, { method: 'POST', body: JSON.stringify({ startDate: formatDate(new Date(endDate.getTime() - 28 * 24 * 60 * 60 * 1000)), endDate: formatDate(new Date(endDate.getTime() - 2 * 24 * 60 * 60 * 1000)), dimensions: ['date'], rowLimit: 30 }) });
	const rows = Array.isArray(data.rows) ? data.rows.map((row: any) => ({ date: row.keys?.[0] || null, clicks: Number(row.clicks || 0), impressions: Number(row.impressions || 0), ctr: Number(row.ctr || 0), position: Number(row.position || 0) })) : [];
	return { provider, property: propertyRef, rows, fetchedAt: now() };
}

function githubRepoPath(value: string) {
	try {
		const url = new URL(value);
		if (url.hostname.toLowerCase() !== 'github.com') return null;
		const parts = url.pathname.split('/').filter(Boolean).map((part) => part.replace(/\.git$/, ''));
		return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
	} catch { return null; }
}

async function githubGet(path: string) {
	const response = await fetch(`https://api.github.com/${path}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'BidLadders/1.0' } });
	if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
	return response.json() as Promise<any>;
}

async function fetchGithubActivity(url: string) {
	const repoPath = githubRepoPath(url);
	if (!repoPath) throw new Error('Use a public github.com/owner/repository URL');
	const [repository, events] = await Promise.all([githubGet(`repos/${repoPath}`), githubGet(`repos/${repoPath}/events?per_page=30`)]);
	return { repository: { name: repository.full_name, description: repository.description, stars: Number(repository.stargazers_count || 0), forks: Number(repository.forks_count || 0), language: repository.language || null, pushedAt: repository.pushed_at || null }, events: (Array.isArray(events) ? events : []).slice(0, 30).map((event: any) => ({ id: event.id, type: event.type, actor: event.actor?.login || null, createdAt: event.created_at || null, ref: event.payload?.ref || event.payload?.action || null, commits: Array.isArray(event.payload?.commits) ? event.payload.commits.length : 0 })) };
}

async function syncGithubActivity(event: RequestEvent, listingId: number, url: string) {
	const activity = await fetchGithubActivity(url);
	const syncedAt = now();
	await getDb(event).prepare('UPDATE listing_details SET github_activity_json = ?, github_synced_at = ?, updated_at = CURRENT_TIMESTAMP WHERE listing_id = ?').bind(JSON.stringify(activity), syncedAt, listingId).run();
	return { activity, syncedAt };
}

async function storedStripeKey(event: RequestEvent, sellerId: number, suppliedKey: string) {
	if (suppliedKey) return suppliedKey;
	const connection = await getDb(event).prepare('SELECT encrypted_key FROM stripe_connections WHERE seller_id = ?').bind(sellerId).first<{ encrypted_key: string }>();
	if (!connection?.encrypted_key) throw new Error('Enter a Stripe restricted key once; it can then be reused for all your product listings');
	const secret = envFrom(event).ENCRYPTION_KEY || envFrom(event).JWT_SECRET || 'local-development-only-change-me';
	return decryptText(connection.encrypted_key, secret);
}

type ListingRow = { id: number; seller_id: number; product_url: string; name: string; summary: string; description: string | null; asking_price_cents: number; mrr_cents: number; mrr_status: string; verified_at: string | null; operating_cost_cents: number; assets_included: string; for_sale: number; product_icon_key: string | null; created_at: string; seller_username: string; seller_profile_image_key: string | null; category: string | null; problem_solved: string | null; audience: string | null; pricing_model: string | null; tech_stack: string | null; total_revenue_cents: number | null; last_30d_revenue_cents: number | null; revenue_daily_json: string | null; active_customers: number | null; deal_count: number; growth_percent: number | null; churn_percent: number | null; github_url: string | null; github_activity_json: string | null; github_synced_at: string | null; google_analytics_property: string | null; google_search_console_url: string | null; google_analytics_json: string | null; google_search_console_json: string | null; public_metrics: number };
type BidRow = { id: number; listing_id: number; amount_cents: number; paid_at: string; expires_at: string };

async function loadRankedListings(event: RequestEvent, query = '') {
	const db = getDb(event);
	const search = normalized(query);
	const filter = search ? 'AND (LOWER(l.name) LIKE ? OR LOWER(l.summary) LIKE ?)' : '';
	const args = search ? [`%${search}%`, `%${search}%`] : [];
	const listingRows = await db.prepare(`SELECT l.id, l.seller_id, l.product_url, l.name, l.summary, l.description, l.asking_price_cents, l.mrr_cents, l.mrr_status, l.verified_at, l.operating_cost_cents, l.assets_included, l.for_sale, l.product_icon_key, l.created_at, u.username AS seller_username, u.profile_image_key AS seller_profile_image_key, d.category, d.problem_solved, d.audience, d.pricing_model, d.tech_stack, d.total_revenue_cents, d.last_30d_revenue_cents, d.revenue_daily_json, d.active_customers, d.growth_percent, d.churn_percent, d.github_url, d.github_activity_json, d.github_synced_at, d.google_analytics_property, d.google_search_console_url, d.google_analytics_json, d.google_search_console_json, d.public_metrics, (SELECT COUNT(*) FROM deals deal WHERE deal.listing_id = l.id AND deal.status NOT IN ('cancelled', 'closed')) AS deal_count FROM listings l JOIN users u ON u.id = l.seller_id LEFT JOIN listing_details d ON d.listing_id = l.id WHERE l.status = 'published' ${filter}`).bind(...args).all<ListingRow>();
	const bidRows = await db.prepare(`SELECT id, listing_id, amount_cents, paid_at, expires_at FROM bids WHERE status = 'paid' AND expires_at > ? ORDER BY amount_cents DESC, paid_at ASC, id ASC`).bind(now()).all<BidRow>();
	const imageRows = await db.prepare('SELECT listing_id, object_key, sort_order FROM listing_images ORDER BY sort_order ASC, id ASC').all<{ listing_id: number; object_key: string; sort_order: number }>();
	const imagesByListing = new Map<number, string[]>();
	for (const image of imageRows.results ?? []) imagesByListing.set(image.listing_id, [...(imagesByListing.get(image.listing_id) || []), mediaUrl(image.object_key)]);
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
		total_revenue: listing.total_revenue_cents == null ? null : Number(listing.total_revenue_cents) / 100,
		last_30d_revenue: listing.last_30d_revenue_cents == null ? null : Number(listing.last_30d_revenue_cents) / 100,
		revenue_daily: parsedJson(listing.revenue_daily_json),
		deal_count: Number(listing.deal_count || 0),
		seller_profile_image_url: mediaUrl(listing.seller_profile_image_key || ''),
		product_icon_url: listing.product_icon_key ? mediaUrl(listing.product_icon_key) : null,
		images: imagesByListing.get(listing.id) || [],
		paid_bid: bestBid.has(listing.id) ? Number(bestBid.get(listing.id)!.amount_cents) / 100 : null,
		rank: index + 1,
		visible_on_home: index < 330,
		for_sale: listing.for_sale !== 0,
		is_sponsored: bestBid.has(listing.id),
		github_activity: parsedJson(listing.github_activity_json),
		github_synced_at: listing.github_synced_at,
		google_analytics: listing.public_metrics ? publicGoogleSummary(listing.google_analytics_json, 'analytics') : null,
		google_search_console: listing.public_metrics ? publicGoogleSummary(listing.google_search_console_json, 'search_console') : null,
		public_metrics: !!listing.public_metrics
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
	const productPages = await Promise.all(['true', 'false'].map((active) => stripeListAll(key, 'products', { active })));
	const products = Array.from(new Map(productPages.flat().map((product: any) => [String(product.id), product])).values());
	const allPrices = await Promise.all(['true', 'false'].map((active) => stripeListAll(key, 'prices', { active })));
	const pricesByProduct = new Map<string, any[]>();
	for (const price of Array.from(new Map(allPrices.flat().map((price: any) => [String(price.id), price])).values())) {
		const productId = String(price.product || '');
		if (!productId) continue;
		pricesByProduct.set(productId, [...(pricesByProduct.get(productId) || []), price]);
	}
	const matched = products.filter((product: any) => {
		const prices = pricesByProduct.get(String(product.id)) || [];
		return tokenMatch(name, [product.name, product.description, ...prices.flatMap((price) => [price.name, price.description, price.nickname, price.lookup_key, JSON.stringify(price.metadata || {})])]);
	});
	if (!matched.length) return [];
	const prices = matched.flatMap((product: any) => pricesByProduct.get(String(product.id)) || []);
	return [{
		id: 'stripe-family',
		name: name.trim(),
		productIds: matched.map((product: any) => String(product.id)),
		productNames: matched.map((product: any) => String(product.name || 'Unnamed Stripe Product')),
		prices: prices.map((price: any) => ({ id: price.id, active: price.active, unit_amount: price.unit_amount, currency: price.currency, recurring: price.recurring }))
	}];
}

async function calculateStripeMetrics(key: string, priceIds: string[]) {
	const priceSet = new Set(priceIds);
	const subscriptions = await stripeListAll(key, 'subscriptions', { status: 'all' });
	const activeCustomers = new Set<string>();
	let mrr = 0;
	let currency = 'usd';
	for (const subscription of subscriptions) {
		if (!['active', 'trialing', 'past_due'].includes(subscription.status)) continue;
		let matches = false;
		for (const item of subscription.items?.data ?? []) {
			if (!priceSet.has(String(item.price?.id || ''))) continue;
			matches = true;
			const recurring = item.price?.recurring;
			const amount = Number(item.price?.unit_amount ?? item.price?.unit_amount_decimal ?? 0);
			if (!recurring || !amount) continue;
			currency = item.price.currency || currency;
			const multiplier = recurring.interval === 'year' ? 1 / (12 * Number(recurring.interval_count || 1)) : recurring.interval === 'week' ? 52 / 12 / Number(recurring.interval_count || 1) : recurring.interval === 'day' ? 365 / 12 / Number(recurring.interval_count || 1) : 1 / Number(recurring.interval_count || 1);
			mrr += amount * Number(item.quantity || 1) * multiplier;
		}
		if (matches && subscription.customer) activeCustomers.add(String(subscription.customer));
	}

	let totalRevenue = 0;
	let last30dRevenue = 0;
	let revenueAvailable = false;
	const dailyRevenue = new Map<string, number>();
	const cutoff = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
	const addRevenue = (amount: unknown, timestamp: unknown, priceId: unknown, revenueCurrency?: string) => {
		if (!priceSet.has(String(priceId || ''))) return;
		const cents = Number(amount || 0);
		if (!Number.isFinite(cents)) return;
		revenueAvailable = true;
		currency = revenueCurrency || currency;
		totalRevenue += cents;
		if (Number(timestamp || 0) >= cutoff) last30dRevenue += cents;
		if (Number(timestamp || 0) >= cutoff) {
			const day = new Date(Number(timestamp) * 1000).toISOString().slice(0, 10);
			dailyRevenue.set(day, (dailyRevenue.get(day) || 0) + cents);
		}
	};

	try {
		const invoices = await stripeListAll(key, 'invoices', { status: 'paid' });
		for (const invoice of invoices) {
			const timestamp = invoice.status_transitions?.paid_at || invoice.created;
			const lines = await stripeInvoiceLines(key, String(invoice.id), invoice.lines?.data ?? []);
			for (const line of lines) addRevenue(line.amount, timestamp, line.price?.id, line.currency);
		}
	} catch {
		// Some restricted keys omit invoice read access; MRR remains verifiable.
	}

	try {
		const sessions = await stripeListAll(key, 'checkout/sessions', { status: 'complete' });
		for (const session of sessions) {
			if (session.mode !== 'payment' || session.payment_status !== 'paid') continue;
			const lines = await stripeCheckoutLineItems(key, String(session.id), session.line_items?.data ?? []);
			for (const line of lines) addRevenue(line.amount_total ?? line.amount_subtotal ?? line.amount, session.created, line.price?.id, line.currency);
		}
	} catch {
		// One-time Checkout attribution is optional when the key lacks Checkout access.
	}

	return { mrr: { cents: Math.round(mrr), currency }, totalRevenue: revenueAvailable ? Math.round(totalRevenue) : null, last30dRevenue: revenueAvailable ? Math.round(last30dRevenue) : null, revenueDaily: [...dailyRevenue.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, cents]) => ({ date, cents })), activeCustomers: activeCustomers.size, currency, revenueAvailable };
}

async function handle(event: RequestEvent): Promise<Response> {
	const route = event.url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
	const segments = route ? route.split('/') : [];
	const method = event.request.method;

	if (route === 'health') return json({ ok: true, app: 'lbl-app', database: !!envFrom(event).DB, time: now() });

	if (route === 'media' && method === 'GET') {
		const key = event.url.searchParams.get('key') || '';
		if (!/^(profiles|listings|listing-icons)\/[A-Za-z0-9._-]+\/(?:[A-Za-z0-9-]+)\.(?:jpg|png|webp|gif)$/.test(key)) return new Response('Not found', { status: 404 });
		const object = await mediaBucket(event).get(key);
		if (!object) return new Response('Not found', { status: 404 });
		return new Response(await object.arrayBuffer(), { headers: { 'content-type': object.httpMetadata?.contentType || 'application/octet-stream', 'cache-control': object.httpMetadata?.cacheControl || 'public, max-age=3600' } });
	}

	if (route === 'media/message' && method === 'GET') {
		const user = await requireUser(event);
		const key = event.url.searchParams.get('key') || '';
		if (!/^messages\/[0-9]+\/[A-Za-z0-9-]+\.(?:jpg|png|webp|gif|mp4|webm|mp3|ogg|wav|pdf)$/.test(key)) return new Response('Not found', { status: 404 });
		const allowed = await getDb(event).prepare('SELECT d.id FROM message_media mm JOIN messages m ON m.id = mm.message_id JOIN deals d ON d.id = m.deal_id WHERE mm.object_key = ? AND (d.seller_id = ? OR (d.buyer_id = ? AND d.buyer_visible = 1))').bind(key, user.id, user.id).first();
		if (!allowed) return new Response('Not found', { status: 404 });
		const object = await mediaBucket(event).get(key);
		if (!object) return new Response('Not found', { status: 404 });
		return new Response(await object.arrayBuffer(), { headers: { 'content-type': object.httpMetadata?.contentType || 'application/octet-stream', 'cache-control': 'private, max-age=3600' } });
	}

	if (route === 'media/profile' && method === 'POST') {
		const user = await requireUser(event);
		const form = await event.request.formData();
		try {
			const file = validateImage(form.get('image'), 'Profile image');
			const key = await putImage(event, file, `profiles/${user.id}`);
			const old = await getDb(event).prepare('SELECT profile_image_key FROM users WHERE id = ?').bind(user.id).first<{ profile_image_key: string | null }>();
			await getDb(event).prepare('UPDATE users SET profile_image_key = ? WHERE id = ?').bind(key, user.id).run();
			if (old?.profile_image_key) await mediaBucket(event).delete(old.profile_image_key);
			return json({ ok: true, profileImageUrl: mediaUrl(key) });
		} catch (error: any) { return json({ error: error?.message || 'Profile image upload failed' }, 400); }
	}

	if (segments[0] === 'profile' && !segments[1] && method === 'GET') {
		const user = await requireUser(event);
		const buyer = user.role === 'buyer' ? await getDb(event).prepare('SELECT legal_name, company_name, role_title, country, timezone, budget_range, purchase_entity FROM buyer_profiles WHERE user_id = ?').bind(user.id).first<any>() : null;
		return json({ profile: { ...user, buyer } });
	}

	if (segments[0] === 'profile' && !segments[1] && method === 'PATCH') {
		const user = await requireUser(event); const input = await body(event);
		const displayName = String(input.displayName || '').trim().slice(0, 80);
		const bio = String(input.bio || '').trim().slice(0, 2000);
		const website = String(input.website || '').trim().slice(0, 500);
		const country = String(input.country || '').trim().slice(0, 120);
		const timezone = String(input.timezone || '').trim().slice(0, 120);
		const contactEmail = String(input.contactEmail || '').trim().slice(0, 254);
		if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) return json({ error: 'Enter a valid contact email' }, 400);
		await getDb(event).prepare('UPDATE users SET display_name = ?, bio = ?, website = ?, country = ?, timezone = ?, contact_email = ? WHERE id = ?').bind(displayName || null, bio || null, website || null, country || null, timezone || null, contactEmail || null, user.id).run();
		if (user.role === 'buyer') {
			const buyer = input.buyer || {};
			if (String(buyer.legalName || '').trim() && String(buyer.roleTitle || '').trim() && String(buyer.country || '').trim() && String(buyer.timezone || '').trim() && String(buyer.budgetRange || '').trim() && ['personal', 'company'].includes(buyer.purchaseEntity)) {
				await getDb(event).prepare('INSERT INTO buyer_profiles (user_id, legal_name, company_name, role_title, country, timezone, budget_range, purchase_entity, terms_accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET legal_name=excluded.legal_name, company_name=excluded.company_name, role_title=excluded.role_title, country=excluded.country, timezone=excluded.timezone, budget_range=excluded.budget_range, purchase_entity=excluded.purchase_entity, terms_accepted_at=excluded.terms_accepted_at').bind(user.id, buyer.legalName, buyer.companyName || null, buyer.roleTitle, buyer.country, buyer.timezone, buyer.budgetRange, buyer.purchaseEntity, now()).run();
			}
		}
		return json({ ok: true });
	}

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

	if (route === 'carousel' && method === 'GET') {
		try {
			const db = getDb(event);
			const orders = await db.prepare("SELECT c.slot_id, c.listing_id, c.starts_at, c.expires_at, l.name, l.product_url, l.summary, l.product_icon_key, (SELECT object_key FROM listing_images image WHERE image.listing_id = l.id ORDER BY image.sort_order ASC, image.id ASC LIMIT 1) AS first_image_key FROM carousel_orders c JOIN listings l ON l.id = c.listing_id WHERE c.status = 'paid' AND c.expires_at > ? AND l.status = 'published' ORDER BY c.slot_id").bind(now()).all<any>();
			const active = new Map((orders.results ?? []).map((row: any) => [Number(row.slot_id), { ...row, image_url: mediaUrl(row.product_icon_key || row.first_image_key || '') }]));
			const slots = await Promise.all(Array.from({ length: 12 }, (_, index) => carouselRequest(event, index + 1, '/', {}).catch(() => ({ slot: { status: 'available' } }))));
			return json({ slots: slots.map((data, index) => ({ id: index + 1, ...data.slot, listing: active.get(index + 1) || null })) });
		} catch (error: any) { return json({ error: error?.message || 'Carousel unavailable' }, 503); }
	}

	if (segments[0] === 'carousel' && segments[1] === 'slots' && segments[2] && segments[3] === 'reserve' && method === 'POST') {
		const user = await requireUser(event); const roleError = forbiddenRole(user, 'seller'); if (roleError) return roleError;
		const slotId = Number(segments[2]); if (!Number.isInteger(slotId) || slotId < 1 || slotId > 12) return json({ error: 'Carousel slot must be between 1 and 12' }, 400);
		const input = await body(event); const listingId = Number(input.listingId);
		const listing = await getDb(event).prepare("SELECT id, name, seller_id FROM listings WHERE id = ? AND seller_id = ? AND status = 'published' AND for_sale = 1").bind(listingId, user.id).first<any>();
		if (!listing) return json({ error: 'Choose one of your published products' }, 404);
		const stripeKey = envFrom(event).STRIPE_SECRET_KEY; if (!stripeKey) return json({ error: 'Carousel payments are not configured yet. Add STRIPE_SECRET_KEY to this Worker.' }, 503);
		let reservation: any;
		try {
			reservation = (await carouselRequest(event, slotId, '/reserve', { listingId, sellerId: user.id })).slot;
			const reservedUntil = new Date(reservation.reservedUntil).toISOString();
			const result = await getDb(event).prepare('INSERT INTO carousel_orders (slot_id, listing_id, seller_id, reservation_id, reserved_until) VALUES (?, ?, ?, ?, ?)').bind(slotId, listingId, user.id, reservation.reservationId, reservedUntil).run();
				const session = await stripePost(stripeKey, 'checkout/sessions', new URLSearchParams({ mode: 'payment', 'payment_method_types[0]': 'card', expires_at: String(Math.floor((Date.now() + CAROUSEL_RESERVATION_MS) / 1000)), 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][product_data][name]': `BidLadders 24-hour product spot: ${listing.name}`, 'line_items[0][price_data][unit_amount]': '1000', 'line_items[0][quantity]': '1', success_url: `${envFrom(event).APP_URL || event.url.origin}/?carousel=success`, cancel_url: `${envFrom(event).APP_URL || event.url.origin}/?carousel=cancelled`, 'metadata[type]': 'carousel_spot', 'metadata[order_id]': String(result.meta.last_row_id), 'metadata[slot_id]': String(slotId), 'metadata[listing_id]': String(listingId), 'metadata[reservation_id]': reservation.reservationId }));
			await getDb(event).prepare('UPDATE carousel_orders SET checkout_session_id = ? WHERE id = ?').bind(session.id, result.meta.last_row_id).run();
			return json({ url: session.url, sessionId: session.id, reservedUntil });
		} catch (error: any) {
			if (reservation?.reservationId) await carouselRequest(event, slotId, '/release', { reservationId: reservation.reservationId }).catch(() => undefined);
			return json({ error: error?.message || 'Unable to reserve carousel spot' }, error?.message?.includes('no longer available') ? 409 : 400);
		}
	}

	if (segments[0] === 'listings' && segments[1] && !segments[2] && method === 'GET') {
		try {
			const listingId = Number(segments[1]);
			const listing = (await loadRankedListings(event)).find((item) => item.id === listingId);
			return listing ? json({ listing }) : json({ error: 'Listing not found' }, 404);
		} catch (error: any) { return json({ error: error?.message || 'Database unavailable' }, 503); }
	}

	if (route === 'listings' && method === 'GET') {
		try { return json({ listings: await loadRankedListings(event, event.url.searchParams.get('q') || '') }); }
		catch (error: any) { return json({ error: error?.message || 'Database unavailable', listings: [] }, 503); }
	}

	if (route === 'listings' && method === 'POST') {
		const user = await requireUser(event); const roleError = forbiddenRole(user, 'seller'); if (roleError) return roleError; const input = await body(event);
		const name = String(input.name || '').trim(); const summary = String(input.summary || '').trim(); const description = String(input.description || '').trim(); const mrrStatus = ['unknown', 'zero', 'verified'].includes(input.mrrStatus) ? input.mrrStatus : 'unknown';
		const githubUrl = String(input.githubUrl || '').trim();
		if (!name || !summary || !input.productUrl || !input.assetsIncluded) return json({ error: 'Product URL, name, summary, and assets included are required' }, 400);
		if (mrrStatus === 'zero' && description.length < 60) return json({ error: 'A $0 MRR listing needs a detailed description of at least 60 characters' }, 400);
		const result = await getDb(event).prepare('INSERT INTO listings (seller_id, product_url, name, summary, description, asking_price_cents, mrr_status, operating_cost_cents, assets_included, for_sale, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(user.id, input.productUrl, name, summary, description || null, asCents(input.askingPrice), mrrStatus, asCents(input.operatingCost), input.assetsIncluded, input.forSale === false ? 0 : 1, input.publish ? 'published' : 'draft').run();
		await getDb(event).prepare('INSERT INTO listing_details (listing_id, category, problem_solved, audience, pricing_model, tech_stack, total_revenue_cents, last_30d_revenue_cents, active_customers, growth_percent, churn_percent, github_url, google_analytics_property, google_search_console_url, public_metrics) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(result.meta.last_row_id, String(input.category || '').trim() || null, String(input.problemSolved || '').trim() || null, String(input.audience || '').trim() || null, String(input.pricingModel || '').trim() || null, String(input.techStack || '').trim() || null, input.totalRevenue === '' || input.totalRevenue == null ? null : asCents(input.totalRevenue), input.last30dRevenue === '' || input.last30dRevenue == null ? null : asCents(input.last30dRevenue), input.activeCustomers === '' || input.activeCustomers == null ? null : Math.max(0, Math.round(Number(input.activeCustomers))), input.growthPercent === '' || input.growthPercent == null ? null : Number(input.growthPercent), input.churnPercent === '' || input.churnPercent == null ? null : Number(input.churnPercent), githubUrl || null, String(input.googleAnalyticsProperty || '').trim() || null, String(input.googleSearchConsoleUrl || '').trim() || null, input.publicMetrics ? 1 : 0).run();
		if (githubUrl) await syncGithubActivity(event, Number(result.meta.last_row_id), githubUrl).catch((error) => console.error('GitHub sync failed', error));
		await audit(event, user.id, 'listing.created', 'listing', String(result.meta.last_row_id), { status: input.publish ? 'published' : 'draft' });
		return json({ id: result.meta.last_row_id });
	}

	if (segments[0] === 'listings' && segments[1] && !segments[2] && method === 'PATCH') {
		const user = await requireUser(event); const roleError = forbiddenRole(user, 'seller'); if (roleError) return roleError;
		const listingId = Number(segments[1]); const input = await body(event);
		const listing = await getDb(event).prepare('SELECT id, mrr_cents, verified_at FROM listings WHERE id = ? AND seller_id = ?').bind(listingId, user.id).first<{ id: number; mrr_cents: number; verified_at: string | null }>();
		if (!listing) return json({ error: 'Listing not found' }, 404);
		const name = String(input.name || '').trim(); const summary = String(input.summary || '').trim(); const description = String(input.description || '').trim(); const productUrl = String(input.productUrl || '').trim(); const assetsIncluded = String(input.assetsIncluded || '').trim(); const mrrStatus = ['unknown', 'zero', 'verified'].includes(input.mrrStatus) ? input.mrrStatus : 'unknown'; const githubUrl = String(input.githubUrl || '').trim();
		if (!name || !summary || !productUrl || !assetsIncluded) return json({ error: 'Product URL, name, summary, and assets included are required' }, 400);
		if (mrrStatus === 'zero' && description.length < 60) return json({ error: 'A $0 MRR listing needs a detailed description of at least 60 characters' }, 400);
		await getDb(event).prepare('UPDATE listings SET product_url = ?, name = ?, summary = ?, description = ?, asking_price_cents = ?, mrr_status = ?, mrr_cents = ?, verified_at = ?, operating_cost_cents = ?, assets_included = ?, for_sale = ?, status = ?, updated_at = ? WHERE id = ? AND seller_id = ?').bind(productUrl, name, summary, description || null, asCents(input.askingPrice), mrrStatus, mrrStatus === 'verified' ? listing.mrr_cents : 0, mrrStatus === 'verified' ? listing.verified_at : null, asCents(input.operatingCost), assetsIncluded, input.forSale === false ? 0 : 1, input.publish ? 'published' : 'draft', now(), listingId, user.id).run();
		await getDb(event).prepare('INSERT INTO listing_details (listing_id, category, problem_solved, audience, pricing_model, tech_stack, total_revenue_cents, last_30d_revenue_cents, active_customers, growth_percent, churn_percent, github_url, google_analytics_property, google_search_console_url, public_metrics) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(listing_id) DO UPDATE SET category=excluded.category, problem_solved=excluded.problem_solved, audience=excluded.audience, pricing_model=excluded.pricing_model, tech_stack=excluded.tech_stack, total_revenue_cents=excluded.total_revenue_cents, last_30d_revenue_cents=excluded.last_30d_revenue_cents, active_customers=excluded.active_customers, growth_percent=excluded.growth_percent, churn_percent=excluded.churn_percent, github_url=excluded.github_url, google_analytics_property=excluded.google_analytics_property, google_search_console_url=excluded.google_search_console_url, public_metrics=excluded.public_metrics, updated_at=CURRENT_TIMESTAMP').bind(listingId, String(input.category || '').trim() || null, String(input.problemSolved || '').trim() || null, String(input.audience || '').trim() || null, String(input.pricingModel || '').trim() || null, String(input.techStack || '').trim() || null, input.totalRevenue === '' || input.totalRevenue == null ? null : asCents(input.totalRevenue), input.last30dRevenue === '' || input.last30dRevenue == null ? null : asCents(input.last30dRevenue), input.activeCustomers === '' || input.activeCustomers == null ? null : Math.max(0, Math.round(Number(input.activeCustomers))), input.growthPercent === '' || input.growthPercent == null ? null : Number(input.growthPercent), input.churnPercent === '' || input.churnPercent == null ? null : Number(input.churnPercent), githubUrl || null, String(input.googleAnalyticsProperty || '').trim() || null, String(input.googleSearchConsoleUrl || '').trim() || null, input.publicMetrics ? 1 : 0).run();
		if (githubUrl) await syncGithubActivity(event, listingId, githubUrl).catch((error) => console.error('GitHub sync failed', error));
		await audit(event, user.id, 'listing.updated', 'listing', String(listingId), { status: input.publish ? 'published' : 'draft' });
		return json({ ok: true, id: listingId });
	}

	if (segments[0] === 'listings' && segments[1] && !segments[2] && method === 'DELETE') {
		const user = await requireUser(event); const roleError = forbiddenRole(user, 'seller'); if (roleError) return roleError;
		const listingId = Number(segments[1]);
		const listing = await getDb(event).prepare('SELECT id FROM listings WHERE id = ? AND seller_id = ?').bind(listingId, user.id).first<{ id: number }>();
		if (!listing) return json({ error: 'Listing not found' }, 404);
		await getDb(event).prepare("UPDATE listings SET status = 'paused', updated_at = ? WHERE id = ? AND seller_id = ?").bind(now(), listingId, user.id).run();
		await audit(event, user.id, 'listing.removed', 'listing', String(listingId), { status: 'paused', public: false });
		return json({ ok: true });
	}

	if (segments[0] === 'listings' && segments[2] === 'images' && method === 'POST') {
		const user = await requireUser(event); const roleError = forbiddenRole(user, 'seller'); if (roleError) return roleError;
		const listingId = Number(segments[1]);
		const listing = await getDb(event).prepare("SELECT id FROM listings WHERE id = ? AND seller_id = ?").bind(listingId, user.id).first<{ id: number }>();
		if (!listing) return json({ error: 'Listing not found' }, 404);
		try {
			const existing = await getDb(event).prepare('SELECT COUNT(*) AS count FROM listing_images WHERE listing_id = ?').bind(listingId).first<{ count: number }>();
			const remaining = 5 - Number(existing?.count || 0);
			if (remaining <= 0) return json({ error: 'A listing can have at most 5 images' }, 400);
			const form = await event.request.formData();
			const files = form.getAll('images').filter((value): value is File => value instanceof File).slice(0, remaining);
			if (!files.length) return json({ error: 'Select at least one image' }, 400);
			for (const [index, file] of files.entries()) {
				validateImage(file, `Listing image ${index + 1}`, new Set(['image/jpeg', 'image/png']));
				const key = await putImage(event, file, `listings/${listingId}`);
				await getDb(event).prepare('INSERT INTO listing_images (listing_id, object_key, mime_type, sort_order) VALUES (?, ?, ?, ?)').bind(listingId, key, file.type, Number(existing?.count || 0) + index).run();
			}
			return json({ ok: true, uploaded: files.length });
		} catch (error: any) { return json({ error: error?.message || 'Listing image upload failed' }, 400); }
	}

	if (segments[0] === 'listings' && segments[2] === 'icon' && method === 'POST') {
		const user = await requireUser(event); const roleError = forbiddenRole(user, 'seller'); if (roleError) return roleError;
		const listingId = Number(segments[1]);
		const listing = await getDb(event).prepare('SELECT id, product_icon_key FROM listings WHERE id = ? AND seller_id = ?').bind(listingId, user.id).first<{ id: number; product_icon_key: string | null }>();
		if (!listing) return json({ error: 'Listing not found' }, 404);
		try {
			const form = await event.request.formData(); const file = validateImage(form.get('icon'), 'Product icon', new Set(['image/jpeg', 'image/png']));
			if (file.size > 1024 * 1024) throw new Error('Product icon must be 1MB or smaller');
			const key = await putImage(event, file, `listing-icons/${listingId}`);
			await getDb(event).prepare('UPDATE listings SET product_icon_key = ?, updated_at = ? WHERE id = ?').bind(key, now(), listingId).run();
			if (listing.product_icon_key) await mediaBucket(event).delete(listing.product_icon_key);
			return json({ ok: true, productIconUrl: mediaUrl(key) });
		} catch (error: any) { return json({ error: error?.message || 'Product icon upload failed' }, 400); }
	}

	if (segments[0] === 'listings' && segments[1] && segments[2] === 'github' && method === 'GET') {
		const listingId = Number(segments[1]);
		const record = await getDb(event).prepare("SELECT l.status, d.github_url, d.github_activity_json, d.github_synced_at FROM listings l LEFT JOIN listing_details d ON d.listing_id = l.id WHERE l.id = ? AND l.status = 'published'").bind(listingId).first<{ status: string; github_url: string | null; github_activity_json: string | null; github_synced_at: string | null }>();
		if (!record?.github_url) return json({ error: 'No public GitHub repository is connected' }, 404);
		const fresh = record.github_synced_at && Date.now() - Date.parse(record.github_synced_at) < 15 * 60 * 1000;
		if (fresh && record.github_activity_json) return json({ activity: parsedJson(record.github_activity_json), syncedAt: record.github_synced_at });
		try { return json(await syncGithubActivity(event, listingId, record.github_url)); }
		catch (error: any) { return record.github_activity_json ? json({ activity: parsedJson(record.github_activity_json), syncedAt: record.github_synced_at, stale: true }) : json({ error: error?.message || 'Unable to load GitHub activity' }, 502); }
	}

	if (segments[0] === 'listings' && segments[1] && segments[2] === 'google' && method === 'GET') {
		const user = await requireUser(event);
		const listingId = Number(segments[1]);
		const record = await getDb(event).prepare('SELECT l.seller_id, d.google_analytics_json, d.google_search_console_json FROM listings l LEFT JOIN listing_details d ON d.listing_id = l.id WHERE l.id = ?').bind(listingId).first<any>();
		if (!record || Number(record.seller_id) !== user.id) return json({ error: 'Listing not found' }, 404);
		return json({ analytics: publicGoogleSummary(record.google_analytics_json, 'analytics'), searchConsole: publicGoogleSummary(record.google_search_console_json, 'search_console') });
	}

	if (route === 'google/connect' && method === 'GET') {
		const user = await requireUser(event);
		if (user.role !== 'seller') return json({ error: 'Seller access required' }, 403);
		const listingId = Number(event.url.searchParams.get('listingId'));
		const provider = event.url.searchParams.get('provider');
		const property = String(event.url.searchParams.get('property') || '').trim();
		if (!Number.isInteger(listingId) || listingId < 1 || !['analytics', 'search_console'].includes(provider || '') || !property) return json({ error: 'Listing, provider, and property are required' }, 400);
		const listing = await getDb(event).prepare("SELECT id FROM listings WHERE id = ? AND seller_id = ? AND status = 'published'").bind(listingId, user.id).first();
		if (!listing) return json({ error: 'Published listing not found' }, 404);
		try {
			const config = googleConfig(event);
			const state = await googleState(event, { listingId, provider, property, sellerId: user.id });
			const redirectUri = `${envFrom(event).APP_URL || event.url.origin}/api/google/callback`;
			const scope = provider === 'analytics' ? 'https://www.googleapis.com/auth/analytics.readonly' : 'https://www.googleapis.com/auth/webmasters.readonly';
			const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
			url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: redirectUri, response_type: 'code', access_type: 'offline', prompt: 'consent', scope, state }).toString();
			return Response.redirect(url.toString(), 302);
		} catch (error: any) { return json({ error: error?.message || 'Google connection is unavailable' }, 503); }
	}

	if (route === 'google/callback' && method === 'GET') {
		const code = event.url.searchParams.get('code') || '';
		const stateValue = event.url.searchParams.get('state') || '';
		const failure = event.url.searchParams.get('error');
		if (failure) return Response.redirect(`${envFrom(event).APP_URL || event.url.origin}/product/${encodeURIComponent(String(event.url.searchParams.get('listingId') || ''))}?google=cancelled`, 302);
		try {
			const state = await readGoogleState(event, stateValue);
			if (!code || !Number.isInteger(Number(state.listingId)) || !['analytics', 'search_console'].includes(state.provider)) throw new Error('Invalid Google callback');
			const redirectUri = `${envFrom(event).APP_URL || event.url.origin}/api/google/callback`;
			const token = await googleTokenRequest(event, new URLSearchParams({ code, grant_type: 'authorization_code', redirect_uri: redirectUri }));
			const refreshToken = String(token.refresh_token || '');
			if (!refreshToken) throw new Error('Google did not return a refresh token. Revoke the connection and try again.');
			const metrics = await fetchGoogleMetrics(event, state.provider, String(state.property), refreshToken);
			const summary = state.provider === 'analytics' ? metrics : { provider: 'search_console', property: metrics.property, period: { start: metrics.rows[0]?.date || null, end: metrics.rows[metrics.rows.length - 1]?.date || null }, clicks: metrics.rows.reduce((sum: number, row: any) => sum + row.clicks, 0), impressions: metrics.rows.reduce((sum: number, row: any) => sum + row.impressions, 0), averagePosition: metrics.rows.length ? metrics.rows.reduce((sum: number, row: any) => sum + row.position, 0) / metrics.rows.length : 0, days: metrics.rows.length, fetchedAt: metrics.fetchedAt };
			await getDb(event).prepare('INSERT INTO google_connections (listing_id, provider, property_ref, encrypted_refresh_token) VALUES (?, ?, ?, ?) ON CONFLICT(listing_id, provider) DO UPDATE SET property_ref=excluded.property_ref, encrypted_refresh_token=excluded.encrypted_refresh_token, updated_at=CURRENT_TIMESTAMP').bind(Number(state.listingId), state.provider, String(state.property), await encryptText(refreshToken, googleEncryptionSecret(event))).run();
			const column = state.provider === 'analytics' ? 'google_analytics_json' : 'google_search_console_json';
			await getDb(event).prepare(`UPDATE listing_details SET ${column} = ?, updated_at = CURRENT_TIMESTAMP WHERE listing_id = ?`).bind(JSON.stringify(summary), Number(state.listingId)).run();
			return Response.redirect(`${envFrom(event).APP_URL || event.url.origin}/product/${encodeURIComponent(String(state.listingId))}?google=connected`, 302);
		} catch (error: any) { return new Response(`Google connection failed: ${error?.message || 'unknown error'}`, { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } }); }
	}

	if (segments[0] === 'stripe' && segments[1] === 'search' && method === 'POST') {
		const user = await requireUser(event); const roleError = forbiddenRole(user, 'seller'); if (roleError) return roleError; const input = await body(event); let key: string;
		try { key = await storedStripeKey(event, user.id, String(input.stripeKey || '')); } catch (error: any) { return json({ error: error?.message || 'Stripe key is required' }, 400); }
		if (!/^rk_(test|live)_/.test(key)) return json({ error: 'Use a Stripe restricted read-only key beginning with rk_test_ or rk_live_' }, 400);
		try { return json({ families: await matchingStripeProducts(key, String(input.name || '')) }); } catch (error: any) { return json({ error: error?.message || 'Stripe search failed' }, 400); }
	}

	if (route === 'stripe/connection' && method === 'GET') {
		const user = await requireUser(event); const roleError = forbiddenRole(user, 'seller'); if (roleError) return roleError;
		const connection = await getDb(event).prepare('SELECT encrypted_key FROM stripe_connections WHERE seller_id = ?').bind(user.id).first<{ encrypted_key: string }>();
		if (!connection?.encrypted_key) return json({ connected: false, maskedKey: null });
		try {
			const secret = envFrom(event).ENCRYPTION_KEY || envFrom(event).JWT_SECRET || 'local-development-only-change-me';
			const key = await decryptText(connection.encrypted_key, secret);
			const maskedKey = key.length > 20 ? `${key.slice(0, 10)}...${key.slice(-10)}` : `${key.slice(0, 4)}...${key.slice(-4)}`;
			return json({ connected: true, maskedKey });
		} catch { return json({ connected: false, maskedKey: null }); }
	}

	if (segments[0] === 'listings' && segments[2] === 'verify' && method === 'POST') {
		const user = await requireUser(event); const roleError = forbiddenRole(user, 'seller'); if (roleError) return roleError; const listingId = Number(segments[1]);
		const listing = await getDb(event).prepare('SELECT id, name FROM listings WHERE id = ? AND seller_id = ?').bind(listingId, user.id).first<{ id: number; name: string }>();
		if (!listing) return json({ error: 'Listing not found' }, 404);
		const input = await body(event); let key: string; try { key = await storedStripeKey(event, user.id, String(input.stripeKey || '')); } catch (error: any) { return json({ error: error?.message || 'Stripe key is required' }, 400); }
		if (!/^rk_(test|live)_/.test(key)) return json({ error: 'Use a Stripe restricted read-only key' }, 400);
		try {
			const families = await matchingStripeProducts(key, listing.name);
			const family = families[0];
			if (!family?.productIds?.length) return json({ error: `No Stripe Product family matched "${listing.name}"` }, 400);
			const records = await Promise.all(family.productIds.map(async (productId: string) => ({ product: await stripeGet(key, `products/${encodeURIComponent(productId)}`), prices: await stripePricesForProduct(key, productId) })));
			const productIds = records.map(({ product }) => String(product.id));
			const prices = records.flatMap(({ prices: productPrices }) => productPrices);
			const priceIds = prices.map((price: any) => String(price.id)).filter(Boolean);
			if (!priceIds.length) return json({ error: 'This Stripe Product has no Prices to monitor' }, 400);
			const metrics = await calculateStripeMetrics(key, priceIds); const secret = envFrom(event).ENCRYPTION_KEY || envFrom(event).JWT_SECRET || 'local-development-only-change-me'; const encrypted = await encryptText(key, secret);
			await getDb(event).prepare('INSERT INTO stripe_connections (seller_id, encrypted_key, last_verified_at) VALUES (?, ?, ?) ON CONFLICT(seller_id) DO UPDATE SET encrypted_key=excluded.encrypted_key, last_verified_at=excluded.last_verified_at').bind(user.id, encrypted, now()).run();
			await getDb(event).prepare('INSERT INTO stripe_product_mappings (listing_id, stripe_product_id, stripe_product_ids, stripe_price_ids, product_name) VALUES (?, ?, ?, ?, ?) ON CONFLICT(listing_id) DO UPDATE SET stripe_product_id=excluded.stripe_product_id, stripe_product_ids=excluded.stripe_product_ids, stripe_price_ids=excluded.stripe_price_ids, product_name=excluded.product_name, updated_at=CURRENT_TIMESTAMP').bind(listingId, productIds[0], JSON.stringify(productIds), JSON.stringify(priceIds), `${listing.name} (${productIds.length} Stripe Products)`).run();
			await getDb(event).prepare('UPDATE listings SET mrr_cents = ?, mrr_status = ?, verified_at = ?, updated_at = ? WHERE id = ? AND seller_id = ?').bind(metrics.mrr.cents, metrics.mrr.cents === 0 ? 'zero' : 'verified', now(), now(), listingId, user.id).run();
			if (metrics.revenueAvailable) await getDb(event).prepare('UPDATE listing_details SET total_revenue_cents = ?, last_30d_revenue_cents = ?, revenue_daily_json = ?, active_customers = ?, updated_at = CURRENT_TIMESTAMP WHERE listing_id = ?').bind(metrics.totalRevenue, metrics.last30dRevenue, JSON.stringify(metrics.revenueDaily), metrics.activeCustomers, listingId).run();
			await getDb(event).prepare('INSERT INTO mrr_snapshots (listing_id, mrr_cents, currency, methodology) VALUES (?, ?, ?, ?)').bind(listingId, metrics.mrr.cents, metrics.mrr.currency, `All ${priceIds.length} Prices across ${productIds.length} Stripe Products matching the listing family; recurring subscriptions normalized monthly; product-attributed paid invoices and one-time Checkout revenue included when the restricted key permits access.`).run();
			await audit(event, user.id, 'listing.mrr_verified', 'listing', String(listingId), { productIds, priceCount: priceIds.length, priceIds, mrrCents: metrics.mrr.cents, revenueAvailable: metrics.revenueAvailable });
			return json({ mrr: metrics.mrr.cents / 100, currency: metrics.mrr.currency, productCount: productIds.length, priceCount: priceIds.length, totalRevenue: metrics.totalRevenue == null ? null : metrics.totalRevenue / 100, last30dRevenue: metrics.last30dRevenue == null ? null : metrics.last30dRevenue / 100, activeCustomers: metrics.activeCustomers, verifiedAt: now() });
		} catch (error: any) { return json({ error: error?.message || 'Stripe verification failed' }, 400); }
	}

	if (segments[0] === 'listings' && segments[2] === 'bid' && method === 'POST') {
		const user = await requireUser(event); const roleError = forbiddenRole(user, 'seller'); if (roleError) return roleError; const listingId = Number(segments[1]);
		const listing = await getDb(event).prepare("SELECT id, name, seller_id FROM listings WHERE id = ? AND seller_id = ? AND status = 'published' AND for_sale = 1").bind(listingId, user.id).first<any>();
		if (!listing) return json({ error: 'Published listing not found' }, 404);
		const input = await body(event); const desiredRank = Math.max(1, Math.min(330, Number(input.desiredRank || 1)));
		await getDb(event).prepare('DELETE FROM rank_reservations WHERE reserved_until <= ?').bind(now()).run();
			const activeBids = await getDb(event).prepare("SELECT amount_cents FROM bids WHERE status = 'paid' AND expires_at > ? ORDER BY amount_cents DESC, paid_at ASC, id ASC").bind(now()).all<{ amount_cents: number }>();
			const targetBid = activeBids.results?.[desiredRank - 1]; const minimum = targetBid ? Number(targetBid.amount_cents) + 50 : 200; const amount = asCents(input.amount);
		if (amount < minimum) return json({ error: `Minimum bid for this position is $${(minimum / 100).toFixed(2)}`, minimum: minimum / 100 }, 400);
		const stripeKey = envFrom(event).STRIPE_SECRET_KEY; if (!stripeKey) return json({ error: 'Bid payments are not configured yet. Add STRIPE_SECRET_KEY to this Worker.' }, 503);
			const expires = new Date(Date.now() + CAROUSEL_RESERVATION_MS).toISOString(); const pending = await getDb(event).prepare('INSERT INTO bids (listing_id, seller_id, amount_cents, desired_rank, expires_at) VALUES (?, ?, ?, ?, ?)').bind(listingId, user.id, amount, desiredRank, expires).run(); const bidId = Number(pending.meta.last_row_id);
			try { await getDb(event).prepare('INSERT INTO rank_reservations (desired_rank, bid_id, reserved_until) VALUES (?, ?, ?)').bind(desiredRank, bidId, expires).run(); }
			catch { await getDb(event).prepare("UPDATE bids SET status = 'cancelled' WHERE id = ?").bind(bidId).run(); return json({ error: 'Another checkout is already holding that rank. Choose another position or wait for it to expire.' }, 409); }
			try {
				const session = await stripePost(stripeKey, 'checkout/sessions', new URLSearchParams({ mode: 'payment', 'payment_method_types[0]': 'card', expires_at: String(Math.floor((Date.now() + CAROUSEL_RESERVATION_MS) / 1000)), 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][product_data][name]': `BidLadders rank boost: ${listing.name}`, 'line_items[0][price_data][unit_amount]': String(amount), 'line_items[0][quantity]': '1', success_url: `${envFrom(event).APP_URL || event.url.origin}/?bid=success`, cancel_url: `${envFrom(event).APP_URL || event.url.origin}/?bid=cancelled`, 'metadata[type]': 'rank_bid', 'metadata[bid_id]': String(bidId), 'metadata[listing_id]': String(listingId), 'metadata[desired_rank]': String(desiredRank) }));
				await getDb(event).prepare('UPDATE bids SET checkout_session_id = ? WHERE id = ?').bind(session.id, bidId).run(); return json({ url: session.url, sessionId: session.id });
			} catch (error) { await getDb(event).prepare('DELETE FROM rank_reservations WHERE bid_id = ?').bind(bidId).run(); await getDb(event).prepare("UPDATE bids SET status = 'cancelled' WHERE id = ?").bind(bidId).run(); throw error; }
	}

	if (route === 'escrow/webhook' && method === 'POST') {
		const expected = envFrom(event).ESCROW_WEBHOOK_SECRET;
		if (!expected || event.url.searchParams.get('secret') !== expected) return json({ error: 'Invalid webhook secret' }, 401);
		const payload = await body(event); const transactionId = String(payload.transaction_id || '');
		if (!/^\d+$/.test(transactionId)) return json({ error: 'transaction_id is required' }, 400);
		try {
			const transaction = await getEscrowTransaction(event, transactionId); const deal = await getDb(event).prepare('SELECT id FROM deals WHERE escrow_transaction_id = ?').bind(transactionId).first<{ id: number }>();
			if (!deal) return json({ received: true });
			const status = verifiedEscrowStatus(transaction as Record<string, any>);
			if (!status) return json({ received: true, verified: true, updated: false });
			await getDb(event).prepare('UPDATE deals SET escrow_status = ?, escrow_updated_at = ?, updated_at = ? WHERE id = ?').bind(status, now(), now(), deal.id).run();
			return json({ received: true, verified: true, updated: true });
		} catch (error: any) { return json({ error: error?.message || 'Escrow webhook verification failed' }, 400); }
	}

	if (route === 'stripe/webhook' && method === 'POST') {
		const signature = event.request.headers.get('stripe-signature'); const secret = envFrom(event).STRIPE_WEBHOOK_SECRET; const raw = await event.request.text();
		if (!signature || !secret || !(await verifyStripeSignature(raw, signature, secret))) return json({ error: 'Invalid Stripe signature' }, 401);
		const stripeEvent = JSON.parse(raw);
		if (stripeEvent.type === 'checkout.session.completed' && stripeEvent.data.object.metadata?.type === 'rank_bid') {
			const session = stripeEvent.data.object; const bidId = Number(session.metadata.bid_id); const bid = await getDb(event).prepare("SELECT id, listing_id, seller_id FROM bids WHERE id = ? AND status = 'pending' AND expires_at > ?").bind(bidId, now()).first<any>();
			if (bid && ['paid', 'no_payment_required'].includes(String(session.payment_status || 'paid'))) { const started = now(); await getDb(event).prepare("UPDATE bids SET status = 'paid', paid_at = ?, starts_at = ?, expires_at = ?, checkout_session_id = ? WHERE id = ? AND status = 'pending'").bind(started, started, PERMANENT_BID_EXPIRY, session.id, bidId).run(); await getDb(event).prepare('DELETE FROM rank_reservations WHERE bid_id = ?').bind(bidId).run(); await getDb(event).prepare("UPDATE bids SET status = 'expired' WHERE listing_id = ? AND id <> ? AND status = 'paid'").bind(bid.listing_id, bidId).run(); await audit(event, bid.seller_id, 'bid.paid', 'bid', String(bidId), { checkoutSessionId: session.id, replacedPreviousBid: true }); }
		}
		if (stripeEvent.type === 'checkout.session.completed' && stripeEvent.data.object.metadata?.type === 'carousel_spot') {
			const session = stripeEvent.data.object; const order = await getDb(event).prepare("SELECT id, slot_id, seller_id, reservation_id FROM carousel_orders WHERE id = ? AND status = 'reserved'").bind(Number(session.metadata.order_id)).first<any>();
			if (order) {
				const confirmed = await carouselRequest(event, Number(order.slot_id), '/confirm', { reservationId: order.reservation_id }).catch(() => null);
				if (confirmed) { const started = new Date(confirmed.slot.startsAt).toISOString(); const expires = new Date(confirmed.slot.expiresAt).toISOString(); await getDb(event).prepare("UPDATE carousel_orders SET status = 'paid', paid_at = ?, starts_at = ?, expires_at = ?, checkout_session_id = ? WHERE id = ?").bind(started, started, expires, session.id, order.id).run(); await audit(event, order.seller_id, 'carousel.paid', 'carousel_order', String(order.id), { checkoutSessionId: session.id, slotId: order.slot_id }); }
			}
		}
		if (stripeEvent.type === 'checkout.session.expired' && stripeEvent.data.object.metadata?.type === 'carousel_spot') {
			const session = stripeEvent.data.object; const order = await getDb(event).prepare("SELECT id, slot_id, reservation_id FROM carousel_orders WHERE id = ? AND status = 'reserved'").bind(Number(session.metadata.order_id)).first<any>();
			if (order) { await carouselRequest(event, Number(order.slot_id), '/release', { reservationId: order.reservation_id }).catch(() => undefined); await getDb(event).prepare("UPDATE carousel_orders SET status = 'expired' WHERE id = ?").bind(order.id).run(); }
		}
		if (stripeEvent.type === 'checkout.session.expired' && stripeEvent.data.object.metadata?.type === 'rank_bid') {
			const session = stripeEvent.data.object;
			await getDb(event).prepare("UPDATE bids SET status = 'expired' WHERE id = ? AND status = 'pending'").bind(Number(session.metadata.bid_id)).run(); await getDb(event).prepare('DELETE FROM rank_reservations WHERE bid_id = ?').bind(Number(session.metadata.bid_id)).run();
		}
		return json({ received: true });
	}

	if (route === 'deals' && method === 'GET') {
		const user = await requireUser(event); const result = await getDb(event).prepare('SELECT d.id, d.buyer_id, d.seller_id, d.status, d.offer_cents, d.escrow_provider, d.escrow_transaction_id, d.escrow_status, d.escrow_url, d.created_at, d.updated_at, l.id AS listing_id, l.name AS listing_name, buyer.username AS buyer_username, seller.username AS seller_username FROM deals d JOIN listings l ON l.id = d.listing_id JOIN users buyer ON buyer.id = d.buyer_id JOIN users seller ON seller.id = d.seller_id WHERE d.seller_id = ? OR (d.buyer_id = ? AND d.buyer_visible = 1) ORDER BY d.updated_at DESC').bind(user.id, user.id).all<any>();
		return json({ deals: (result.results ?? []).map((deal: any) => ({ ...deal, offer: deal.offer_cents / 100 })) });
	}

	if (segments[0] === 'deals' && segments[1] === 'offer' && method === 'POST') {
		const user = await requireUser(event); const roleError = forbiddenRole(user, 'buyer'); if (roleError) return roleError; const input = await body(event);
		const buyerProfile = await getDb(event).prepare('SELECT user_id FROM buyer_profiles WHERE user_id = ?').bind(user.id).first();
		if (!buyerProfile) return json({ error: 'Complete buyer onboarding before contacting a seller' }, 400);
		const listing = await getDb(event).prepare("SELECT id, seller_id FROM listings WHERE id = ? AND status = 'published' AND for_sale = 1").bind(Number(input.listingId)).first<{ id: number; seller_id: number }>();
		if (!listing || listing.seller_id === user.id) return json({ error: 'Published listing not found' }, 404);
		const message = String(input.message || '').trim(); if (!message) return json({ error: 'Include a message with your offer' }, 400);
		const result = await getDb(event).prepare("INSERT INTO deals (listing_id, buyer_id, seller_id, offer_cents, status) VALUES (?, ?, ?, ?, 'inquiry')").bind(listing.id, user.id, listing.seller_id, asCents(input.offer)).run();
		await getDb(event).prepare('INSERT INTO messages (deal_id, sender_id, body) VALUES (?, ?, ?)').bind(result.meta.last_row_id, user.id, message).run(); await audit(event, user.id, 'deal.offer_created', 'deal', String(result.meta.last_row_id), { listingId: listing.id }); return json({ id: result.meta.last_row_id });
	}

	if (segments[0] === 'deals' && segments[1] && !segments[2] && method === 'GET') {
		const user = await requireUser(event); const deal = await getDb(event).prepare('SELECT d.*, l.name AS listing_name, l.product_url, buyer.username AS buyer_username, seller.username AS seller_username FROM deals d JOIN listings l ON l.id = d.listing_id JOIN users buyer ON buyer.id = d.buyer_id JOIN users seller ON seller.id = d.seller_id WHERE d.id = ? AND (d.seller_id = ? OR (d.buyer_id = ? AND d.buyer_visible = 1))').bind(Number(segments[1]), user.id, user.id).first<any>();
		return deal ? json({ deal: { ...deal, offer: deal.offer_cents / 100 } }) : json({ error: 'Deal not found' }, 404);
	}

	if (segments[0] === 'deals' && segments[1] && segments[2] === 'accept' && method === 'POST') {
		const user = await requireUser(event);
		const deal = await getDb(event).prepare("SELECT id, seller_id, status FROM deals WHERE id = ? AND seller_id = ?").bind(Number(segments[1]), user.id).first<{ id: number; seller_id: number; status: string }>();
		if (!deal) return json({ error: 'Deal not found' }, 404);
		if (!['inquiry', 'negotiating'].includes(deal.status)) return json({ error: 'Only an open deal can be accepted' }, 409);
		await getDb(event).prepare("UPDATE deals SET status = 'accepted', updated_at = ? WHERE id = ? AND seller_id = ?").bind(now(), deal.id, user.id).run();
		await audit(event, user.id, 'deal.accepted', 'deal', String(deal.id));
		return json({ ok: true, status: 'accepted' });
	}

	if (segments[0] === 'deals' && segments[1] && segments[2] === 'cancel' && method === 'POST') {
		const user = await requireUser(event);
		const deal = await getDb(event).prepare("SELECT id, buyer_id, status FROM deals WHERE id = ? AND buyer_id = ? AND buyer_visible = 1").bind(Number(segments[1]), user.id).first<any>();
		if (!deal) return json({ error: 'Deal not found' }, 404);
		if (['cancelled', 'closed'].includes(deal.status)) return json({ ok: true, status: deal.status });
		await getDb(event).prepare("UPDATE deals SET status = 'cancelled', buyer_visible = 0, cancelled_at = ?, updated_at = ? WHERE id = ? AND buyer_id = ?").bind(now(), now(), deal.id, user.id).run();
		await audit(event, user.id, 'deal.cancelled_by_buyer', 'deal', String(deal.id));
		return json({ ok: true, status: 'cancelled' });
	}

	if (segments[0] === 'deals' && segments[1] && segments[2] === 'escrow' && method === 'POST') {
		const user = await requireUser(event);
		const deal = await getDb(event).prepare("SELECT d.*, l.name AS listing_name, l.product_url, buyer.contact_email AS buyer_email, seller.contact_email AS seller_email FROM deals d JOIN listings l ON l.id = d.listing_id JOIN users buyer ON buyer.id = d.buyer_id JOIN users seller ON seller.id = d.seller_id WHERE d.id = ? AND (d.seller_id = ? OR (d.buyer_id = ? AND d.buyer_visible = 1))").bind(Number(segments[1]), user.id, user.id).first<any>();
		if (!deal) return json({ error: 'Deal not found' }, 404);
		if (deal.status !== 'accepted') return json({ error: 'The seller must accept the deal before escrow can start' }, 409);
		if (deal.escrow_transaction_id) return json({ escrow: { provider: deal.escrow_provider, transactionId: deal.escrow_transaction_id, status: deal.escrow_status, url: deal.escrow_url } });
		if (!deal.buyer_email || !deal.seller_email) return json({ error: 'Both buyer and seller must add an escrow contact email in Profile' }, 400);
		const amountCents = Math.max(1, Number(deal.offer_cents));
			const platformFeeCents = platformFeeForAmount(amountCents); const escrow = await createEscrowTransaction(event, { buyerEmail: deal.buyer_email, sellerEmail: deal.seller_email, title: deal.listing_name, description: `Product acquisition for ${deal.listing_name}`, merchantUrl: `${envFrom(event).APP_URL || event.url.origin}/product/${deal.listing_id}`, amountCents, platformFeeCents });
		const transactionId = String(escrow.id || '');
		if (!transactionId) throw new Error('Escrow.com did not return a transaction id');
			const webLink = await escrowWebLink(event, transactionId, 'agree').catch(() => ({} as any)); const escrowUrl = String(webLink.landing_page || ''); const updatedAt = now();
			await getDb(event).prepare("UPDATE deals SET escrow_provider = 'escrow.com', escrow_transaction_id = ?, escrow_status = 'created', escrow_url = ?, escrow_updated_at = ?, updated_at = ? WHERE id = ? AND escrow_transaction_id IS NULL").bind(transactionId, escrowUrl || null, updatedAt, updatedAt, deal.id).run();
		await audit(event, user.id, 'deal.escrow_created', 'deal', String(deal.id), { provider: 'escrow.com', transactionId, amountCents, platformFeeCents: platformFeeForAmount(amountCents) });
			return json({ escrow: { provider: 'escrow.com', transactionId, status: 'created', url: escrowUrl || null } });
	}

	if (segments[0] === 'deals' && segments[1] && segments[2] === 'messages' && !segments[3] && method === 'GET') {
		const user = await requireUser(event); const deal = await getDb(event).prepare('SELECT id FROM deals WHERE id = ? AND (seller_id = ? OR (buyer_id = ? AND buyer_visible = 1))').bind(Number(segments[1]), user.id, user.id).first(); if (!deal) return json({ error: 'Deal not found' }, 404);
		const messages = await getDb(event).prepare('SELECT m.id, m.body, m.created_at, u.username FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.deal_id = ? ORDER BY m.created_at ASC').bind(Number(segments[1])).all<any>();
		const media = await getDb(event).prepare('SELECT mm.message_id, mm.object_key, mm.mime_type, mm.byte_size FROM message_media mm JOIN messages m ON m.id = mm.message_id WHERE m.deal_id = ? ORDER BY mm.id ASC').bind(Number(segments[1])).all<any>();
		const mediaByMessage = new Map<number, any[]>(); for (const item of media.results ?? []) mediaByMessage.set(Number(item.message_id), [...(mediaByMessage.get(Number(item.message_id)) || []), { url: `/api/media/message?key=${encodeURIComponent(item.object_key)}`, mime_type: item.mime_type, byte_size: item.byte_size }]);
		return json({ messages: (messages.results ?? []).map((message: any) => ({ ...message, media: mediaByMessage.get(Number(message.id)) || [] })) });
	}

	if (segments[0] === 'deals' && segments[1] && segments[2] === 'messages' && segments[3] === 'media' && method === 'POST') {
		const user = await requireUser(event);
		const dealId = Number(segments[1]);
		const deal = await getDb(event).prepare('SELECT id FROM deals WHERE id = ? AND (seller_id = ? OR (buyer_id = ? AND buyer_visible = 1))').bind(dealId, user.id, user.id).first();
		if (!deal) return json({ error: 'Deal not found' }, 404);
		try {
			const form = await event.request.formData();
			const file = form.get('media');
			if (!(file instanceof File) || !file.size) return json({ error: 'Select a media file' }, 400);
			if (file.size > MAX_MESSAGE_MEDIA_BYTES) return json({ error: 'Media must be 1MB or smaller' }, 400);
			if (!MESSAGE_MEDIA_TYPES.has(file.type)) return json({ error: 'Unsupported media type' }, 400);
			const key = `messages/${dealId}/${crypto.randomUUID()}.${extensionFor(file.type)}`;
			await mediaBucket(event).put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type, cacheControl: 'private, max-age=3600' } });
			const message = String(form.get('body') || '').trim().slice(0, 5000) || 'Media attachment';
			const result = await getDb(event).prepare('INSERT INTO messages (deal_id, sender_id, body) VALUES (?, ?, ?)').bind(dealId, user.id, message).run();
			await getDb(event).prepare('INSERT INTO message_media (message_id, object_key, mime_type, byte_size) VALUES (?, ?, ?, ?)').bind(result.meta.last_row_id, key, file.type, file.size).run();
			await getDb(event).prepare('UPDATE deals SET updated_at = ? WHERE id = ?').bind(now(), dealId).run();
			return json({ ok: true, messageId: result.meta.last_row_id });
		} catch (error: any) { return json({ error: error?.message || 'Media upload failed' }, 400); }
	}

	if (segments[0] === 'deals' && segments[1] && segments[2] === 'messages' && !segments[3] && method === 'POST') {
		const user = await requireUser(event); const deal = await getDb(event).prepare('SELECT id FROM deals WHERE id = ? AND (seller_id = ? OR (buyer_id = ? AND buyer_visible = 1))').bind(Number(segments[1]), user.id, user.id).first(); if (!deal) return json({ error: 'Deal not found' }, 404);
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
export const PATCH = safeHandle;
export const DELETE = safeHandle;
