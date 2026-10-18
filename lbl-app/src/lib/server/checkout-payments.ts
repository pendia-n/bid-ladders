import type { D1Database } from '@cloudflare/workers-types';

export function checkoutPaymentParameters(values: Record<string, string>): URLSearchParams {
	return new URLSearchParams({ ...values, 'payment_method_types[0]': 'card', 'payment_method_types[1]': 'crypto' });
}

export function isPaidCheckoutEvent(eventType: string, paymentStatus: unknown): boolean {
	return ['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(eventType) && paymentStatus === 'paid';
}

export async function fulfillRankCheckout(db: D1Database, bidId: number, sessionId: string, timestamp = Date.now()) {
	const bid = await db.prepare("SELECT id, listing_id, seller_id FROM bids WHERE id = ? AND checkout_session_id = ? AND status = 'pending'").bind(bidId, sessionId).first<{ id: number; listing_id: number; seller_id: number }>();
	if (!bid) return null;
	const started = new Date(timestamp).toISOString();
	const results = await db.batch([
		db.prepare("UPDATE bids SET status = 'paid', paid_at = ?, starts_at = ?, expires_at = ? WHERE id = ? AND checkout_session_id = ? AND status = 'pending'").bind(started, started, '9999-12-31T23:59:59.999Z', bidId, sessionId),
		db.prepare("UPDATE bids SET status = 'expired' WHERE listing_id = ? AND id <> ? AND status = 'paid' AND EXISTS (SELECT 1 FROM bids current_bid WHERE current_bid.id = ? AND current_bid.status = 'paid')").bind(bid.listing_id, bidId, bidId),
		db.prepare('DELETE FROM rank_reservations WHERE bid_id = ?').bind(bidId)
	]);
	return results[0].meta.changes ? bid : null;
}
