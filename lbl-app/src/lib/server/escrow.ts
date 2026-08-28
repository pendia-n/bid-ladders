import type { RequestEvent } from '@sveltejs/kit';
import { envFrom } from './auth';

type EscrowInput = {
	buyerEmail: string;
	sellerEmail: string;
	title: string;
	description: string;
	merchantUrl: string;
	amountCents: number;
	platformFeeCents: number;
	inspectionDays?: number;
};

function config(event: RequestEvent) {
	const env = envFrom(event);
	if (!env.ESCROW_API_EMAIL || !env.ESCROW_API_KEY) throw new Error('Escrow is not configured. Add ESCROW_API_EMAIL and ESCROW_API_KEY to the Worker secrets first.');
	return { email: env.ESCROW_API_EMAIL, key: env.ESCROW_API_KEY, baseUrl: (env.ESCROW_API_BASE_URL || 'https://api.escrow.com/2017-09-01').replace(/\/$/, '') };
}

async function escrowRequest(event: RequestEvent, path: string, init: RequestInit = {}) {
	const settings = config(event);
	const auth = btoa(`${settings.email}:${settings.key}`);
	const headers = new Headers(init.headers);
	headers.set('authorization', `Basic ${auth}`);
	headers.set('content-type', 'application/json');
	const response = await fetch(`${settings.baseUrl}${path}`, { ...init, headers });
	const data = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(data?.message || data?.error || `Escrow.com returned ${response.status}`);
	return data as any;
}

function tieredPlatformFeeCents(amountCents: number) {
	if (amountCents < 1_000_000) return Math.round(amountCents * 0.08);
	if (amountCents < 5_000_000) return Math.round(amountCents * 0.035);
	return Math.round(amountCents * 0.017);
}

export function platformFeeForAmount(amountCents: number) {
	return tieredPlatformFeeCents(amountCents);
}

export async function createEscrowTransaction(event: RequestEvent, input: EscrowInput) {
	const amount = Math.max(1, Math.round(input.amountCents));
	const platformFee = Math.max(0, Math.min(Math.round(input.platformFeeCents), amount));
	const inspectionDays = Math.min(30, Math.max(1, Math.round(input.inspectionDays || 3)));
	const items: Record<string, unknown>[] = [{
		title: input.title.slice(0, 200),
		description: input.description.slice(0, 500),
		type: 'general_merchandise',
		category: 'computer_hardware_and_software',
		inspection_period: inspectionDays * 86400,
		quantity: 1,
		extra_attributes: { merchant_url: input.merchantUrl.slice(0, 500), shipping_type: 'no_shipping' },
		schedule: [{ amount: amount / 100, payer_customer: input.buyerEmail, beneficiary_customer: input.sellerEmail }],
		fees: [
			{ payer_customer: input.buyerEmail, type: 'escrow', split: 0.5 },
			{ payer_customer: input.sellerEmail, type: 'escrow', split: 0.5 }
		]
	}];
	if (platformFee > 0) items.push({
		title: 'BidLadders marketplace fee',
		description: 'Marketplace fee for facilitating this product acquisition.',
		type: 'partner_fee',
		schedule: [{ amount: platformFee / 100, payer_customer: input.buyerEmail, beneficiary_customer: 'me' }]
	});
	return escrowRequest(event, '/transaction', {
		method: 'POST',
		body: JSON.stringify({
			parties: [{ role: 'buyer', customer: input.buyerEmail }, { role: 'seller', customer: input.sellerEmail }],
			currency: 'usd',
			description: `BidLadders acquisition: ${input.title}`.slice(0, 256),
			items
		})
	});
}

export async function getEscrowTransaction(event: RequestEvent, transactionId: string) {
	if (!/^\d+$/.test(transactionId)) throw new Error('Invalid Escrow transaction id');
	return escrowRequest(event, `/transaction/${transactionId}`);
}

export async function escrowWebLink(event: RequestEvent, transactionId: string, action: string) {
	if (!/^\d+$/.test(transactionId) || !/^[a-z_]+$/.test(action)) throw new Error('Invalid Escrow transaction link request');
	return escrowRequest(event, `/transaction/${transactionId}/web_link/${action}`);
}
