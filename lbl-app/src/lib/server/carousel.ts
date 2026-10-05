import type { D1Database, DurableObjectState } from '@cloudflare/workers-types';

type SlotRecord = {
	status: 'available' | 'reserved' | 'paid';
	reservationId?: string;
	listingId?: number;
	sellerId?: number;
	orderId?: number;
	checkoutSessionId?: string;
	reservedUntil?: number;
	startsAt?: number;
	expiresAt?: number;
	synced?: boolean;
};

type CarouselEnv = { DB: D1Database; STRIPE_SECRET_KEY: string };

const reservationMs = 35 * 60 * 1000;
const placementMs = 24 * 60 * 60 * 1000;
const retryMs = 60 * 1000;

export class CarouselSlot {
	private readonly ctx: DurableObjectState;
	private readonly env: CarouselEnv;

	constructor(ctx: DurableObjectState, env: CarouselEnv) {
		this.ctx = ctx;
		this.env = env;
	}

	private async read(): Promise<SlotRecord> {
		return (await this.ctx.storage.get<SlotRecord>('slot')) || { status: 'available' };
	}

	private async syncPaidOrder(record: SlotRecord): Promise<SlotRecord> {
		if (!record.orderId) {
			const synced = { ...record, synced: true };
			await this.ctx.storage.put('slot', synced);
			await this.ctx.storage.setAlarm(record.expiresAt!);
			return synced;
		}
		const started = new Date(record.startsAt!).toISOString();
		const expires = new Date(record.expiresAt!).toISOString();
		const result = await this.env.DB.prepare("UPDATE carousel_orders SET status = 'paid', paid_at = ?, starts_at = ?, expires_at = ?, checkout_session_id = ? WHERE id = ? AND reservation_id = ? AND status IN ('reserved', 'paid')")
			.bind(started, started, expires, record.checkoutSessionId, record.orderId, record.reservationId).run();
		if (!result.success || !result.meta.changes) throw new Error('Unable to record paid carousel placement');
		const synced = { ...record, synced: true };
		await this.ctx.storage.put('slot', synced);
		await this.ctx.storage.setAlarm(record.expiresAt!);
		return synced;
	}

	private async activate(record: SlotRecord, timestamp: number): Promise<SlotRecord> {
		const paid: SlotRecord = { ...record, status: 'paid', startsAt: timestamp, expiresAt: timestamp + placementMs, synced: false };
		await this.ctx.storage.put('slot', paid);
		await this.ctx.storage.setAlarm(timestamp + retryMs);
		return this.syncPaidOrder(paid);
	}

	private async expire(record: SlotRecord): Promise<SlotRecord> {
		await this.ctx.storage.delete('slot');
		if (record.orderId) {
			await this.env.DB.prepare("UPDATE carousel_orders SET status = 'expired' WHERE id = ? AND reservation_id = ? AND status = 'reserved'")
				.bind(record.orderId, record.reservationId).run();
		}
		return { status: 'available' };
	}

	private async retry(record: SlotRecord, timestamp: number): Promise<SlotRecord> {
		const pending = { ...record, reservedUntil: timestamp + retryMs };
		await this.ctx.storage.put('slot', pending);
		await this.ctx.storage.setAlarm(pending.reservedUntil);
		return pending;
	}

	private async current(): Promise<SlotRecord> {
		const timestamp = Date.now();
		const record = await this.read();
		if (record.status === 'paid') {
			if ((record.expiresAt || 0) <= timestamp) {
				await this.ctx.storage.delete('slot');
				return { status: 'available' };
			}
			if (!record.synced) {
				try { return await this.syncPaidOrder(record); }
				catch { await this.ctx.storage.setAlarm(timestamp + retryMs); }
			}
			return record;
		}
		if (record.status !== 'reserved' || (record.reservedUntil || 0) > timestamp) return record;
		if (!record.checkoutSessionId) return this.expire(record);
		let session: { id: string; status: string; payment_status: string };
		try {
			const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(record.checkoutSessionId)}`, {
				headers: { authorization: `Bearer ${this.env.STRIPE_SECRET_KEY}` }
			});
			if (!response.ok) throw new Error(`Stripe returned ${response.status}`);
			session = await response.json() as { id: string; status: string; payment_status: string };
			if (session.id !== record.checkoutSessionId) throw new Error('Checkout session mismatch');
		} catch {
			// Keep the spot unavailable until Stripe confirms whether checkout was paid.
			return this.retry(record, timestamp);
		}
		if (session.status === 'complete' && session.payment_status === 'paid') return this.activate(record, timestamp);
		if (session.status === 'expired') return this.expire(record);
		return this.retry(record, timestamp);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const current = await this.current();
		if (request.method === 'GET' || url.pathname === '/') return Response.json({ slot: current });
		const input = await request.json().catch(() => ({})) as Record<string, unknown>;
		if (url.pathname === '/reserve') {
			if (current.status !== 'available') return Response.json({ error: 'This carousel spot is no longer available' }, { status: 409 });
			const record: SlotRecord = { status: 'reserved', reservationId: crypto.randomUUID(), listingId: Number(input.listingId), sellerId: Number(input.sellerId), reservedUntil: Date.now() + reservationMs };
			await this.ctx.storage.put('slot', record);
			await this.ctx.storage.setAlarm(record.reservedUntil!);
			return Response.json({ slot: record });
		}
		if (url.pathname === '/checkout') {
			if (current.status !== 'reserved' || current.reservationId !== String(input.reservationId) || current.checkoutSessionId) return Response.json({ error: 'Carousel reservation is no longer valid' }, { status: 409 });
			const record = { ...current, orderId: Number(input.orderId), checkoutSessionId: String(input.sessionId) };
			if (!Number.isInteger(record.orderId) || record.orderId < 1 || !record.checkoutSessionId.startsWith('cs_')) return Response.json({ error: 'Invalid checkout session' }, { status: 400 });
			await this.ctx.storage.put('slot', record);
			return Response.json({ slot: record });
		}
		if (url.pathname === '/confirm') {
			if (current.reservationId !== String(input.reservationId) || (current.checkoutSessionId && current.checkoutSessionId !== String(input.sessionId))) return Response.json({ error: 'Carousel reservation is no longer valid' }, { status: 409 });
			if (current.status === 'paid') return Response.json({ slot: current.synced ? current : await this.syncPaidOrder(current) });
			if (current.status !== 'reserved') return Response.json({ error: 'Carousel reservation is no longer valid' }, { status: 409 });
			return Response.json({ slot: await this.activate(current, Date.now()) });
		}
		if (url.pathname === '/release') {
			if (current.status === 'reserved' && current.reservationId === String(input.reservationId) && (!input.sessionId || current.checkoutSessionId === String(input.sessionId))) await this.expire(current);
			return Response.json({ ok: true });
		}
		return Response.json({ error: 'Not found' }, { status: 404 });
	}

	async alarm() {
		await this.current();
	}
}
