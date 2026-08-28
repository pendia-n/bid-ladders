import type { DurableObjectState } from '@cloudflare/workers-types';

type SlotRecord = {
	status: 'available' | 'reserved' | 'paid';
	reservationId?: string;
	listingId?: number;
	sellerId?: number;
	reservedUntil?: number;
	startsAt?: number;
	expiresAt?: number;
};

// Match the shortest Stripe Checkout expiry used by the Worker.
const reservationMs = 35 * 60 * 1000;
const placementMs = 24 * 60 * 60 * 1000;

export class CarouselSlot {
	constructor(private readonly ctx: DurableObjectState) {}
	private async read(): Promise<SlotRecord> {
		return (await this.ctx.storage.get<SlotRecord>('slot')) || { status: 'available' };
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const timestamp = Date.now();
		let current = await this.read();
		if ((current.status === 'reserved' && (current.reservedUntil || 0) <= timestamp) || (current.status === 'paid' && (current.expiresAt || 0) <= timestamp)) {
			await this.ctx.storage.delete('slot');
			current = { status: 'available' };
		}
		if (request.method === 'GET') return Response.json({ slot: current });
		const input = await request.json().catch(() => ({})) as Record<string, unknown>;
		if (url.pathname === '/') return Response.json({ slot: current });
		if (url.pathname === '/reserve') {
			if (current.status !== 'available') return Response.json({ error: 'This carousel spot is no longer available' }, { status: 409 });
			const record: SlotRecord = { status: 'reserved', reservationId: crypto.randomUUID(), listingId: Number(input.listingId), sellerId: Number(input.sellerId), reservedUntil: timestamp + reservationMs };
			await this.ctx.storage.put('slot', record);
			await this.ctx.storage.setAlarm(record.reservedUntil!);
			return Response.json({ slot: record });
		}
		if (url.pathname === '/confirm') {
			if (current.status === 'paid' && current.reservationId === String(input.reservationId)) return Response.json({ slot: current });
			if (current.status !== 'reserved' || current.reservationId !== String(input.reservationId)) return Response.json({ error: 'Carousel reservation is no longer valid' }, { status: 409 });
			const record: SlotRecord = { ...current, status: 'paid', startsAt: timestamp, expiresAt: timestamp + placementMs };
			await this.ctx.storage.put('slot', record);
			await this.ctx.storage.setAlarm(record.expiresAt!);
			return Response.json({ slot: record });
		}
		if (url.pathname === '/release') {
			if (current.reservationId === String(input.reservationId)) await this.ctx.storage.delete('slot');
			return Response.json({ ok: true });
		}
		return Response.json({ error: 'Not found' }, { status: 404 });
	}

	async alarm() {
		const current = await this.read();
		if ((current.status === 'reserved' && (current.reservedUntil || 0) <= Date.now()) || (current.status === 'paid' && (current.expiresAt || 0) <= Date.now())) await this.ctx.storage.delete('slot');
	}
}
