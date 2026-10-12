import type { D1Database, DurableObjectState } from '@cloudflare/workers-types';

type CheckoutRecord = { sessionId: string; bidId: number; deadline: number };
type CheckoutEnv = { DB: D1Database; STRIPE_SECRET_KEY: string };

const retryMs = 30 * 1000;

export class RankCheckoutExpiry {
	private readonly ctx: DurableObjectState;
	private readonly env: CheckoutEnv;

	constructor(ctx: DurableObjectState, env: CheckoutEnv) {
		this.ctx = ctx;
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		if (request.method !== 'POST' || new URL(request.url).pathname !== '/watch') return new Response('Not found', { status: 404 });
		const input = await request.json() as CheckoutRecord;
		if (!input.sessionId?.startsWith('cs_') || !Number.isInteger(input.bidId) || !Number.isFinite(input.deadline)) return Response.json({ error: 'Invalid checkout watcher details' }, { status: 400 });
		await this.ctx.storage.put('checkout', input);
		await this.ctx.storage.setAlarm(input.deadline);
		return Response.json({ ok: true });
	}

	private async getSession(sessionId: string) {
		const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
			headers: { authorization: `Bearer ${this.env.STRIPE_SECRET_KEY}` }
		});
		if (!response.ok) throw new Error(`Stripe returned ${response.status}`);
		return await response.json() as { id: string; status: string; payment_status: string };
	}

	private async expireBid(bidId: number) {
		await this.env.DB.batch([
			this.env.DB.prepare("UPDATE bids SET status = 'expired' WHERE id = ? AND status = 'pending'").bind(bidId),
			this.env.DB.prepare('DELETE FROM rank_reservations WHERE bid_id = ?').bind(bidId)
		]);
	}

	async alarm() {
		const record = await this.ctx.storage.get<CheckoutRecord>('checkout');
		if (!record) return;
		const timestamp = Date.now();
		if (record.deadline > timestamp) {
			await this.ctx.storage.setAlarm(record.deadline);
			return;
		}
		try {
			let session = await this.getSession(record.sessionId);
			if (session.id !== record.sessionId) throw new Error('Checkout session mismatch');
			if (session.status === 'open') {
				const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(record.sessionId)}/expire`, {
					method: 'POST',
					headers: { authorization: `Bearer ${this.env.STRIPE_SECRET_KEY}` }
				});
				if (response.ok) session = await response.json() as typeof session;
				else session = await this.getSession(record.sessionId);
			}
			if (session.status === 'expired') {
				await this.expireBid(record.bidId);
				await this.ctx.storage.delete('checkout');
				return;
			}
			if (session.status === 'complete' && session.payment_status === 'paid') {
				await this.ctx.storage.delete('checkout');
				return;
			}
		} catch {
			// Retain the rank reservation until Stripe confirms a terminal state.
		}
		await this.ctx.storage.setAlarm(timestamp + retryMs);
	}
}
