# BidLadders

BidLadders is a product-level acquisition marketplace. Sellers publish one product per listing; buyers discover the first 330 listings, inspect the available evidence, and open a private deal room. Paid ranks are permanent until another successful bid replaces the listing's paid rank. Free listings are ordered by arrival after paid listings.

## Implemented product flow

- Seller-only listing creation, editing, pausing, deleting, product icon, and up to five PNG/JPG images.
- Product-family Stripe verification: the seller searches by listing name, then every matching Stripe Product and every active or inactive Price under those Products is stored for monitoring. No individual Price selection is used.
- MRR from active, trialing, and past-due recurring subscriptions, normalized to a monthly value.
- Product-attributed paid invoice and one-time Checkout revenue, including a rolling 30-day total and daily series when the restricted Stripe key exposes it.
- Direct Charges created without an invoice or Checkout line-item Price ID cannot be reliably attributed to a Product; those amounts are left out rather than guessed.
- Optional Google Analytics and Search Console OAuth connections. Public summaries require explicit seller opt-in; owners can see their connected summaries privately.
- Twelve Durable Object carousel spots. Each spot is reserved before Checkout, charged exactly $10 through inline Stripe `price_data`, and remains live for exactly 24 hours after the signed webhook confirms payment.
- Permanent rank bids use inline dynamic Stripe `price_data`; a paid bid remains until a later successful bid replaces it. A D1-backed reservation prevents two simultaneous Checkout sessions from holding the same target rank.
- Buyer onboarding, creator-only product controls, private deal rooms, buyer cancellation with preserved D1 history, 1 MB R2-backed message attachments, and active conversation counts per listing.
- Escrow.com transaction creation, agreement link, provider-verified webhook status refresh, and marketplace partner fee calculation are configuration-gated.

## Required production setup

Set these Worker secrets:

```text
JWT_SECRET
ENCRYPTION_KEY
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
ESCROW_API_EMAIL
ESCROW_API_KEY
ESCROW_WEBHOOK_SECRET
```

Set `ESCROW_API_BASE_URL` as a non-secret variable for sandbox testing:

```text
https://api.escrow-sandbox.com/2017-09-01
```

Production defaults to `https://api.escrow.com/2017-09-01`. Set `APP_URL` to the public Worker URL when using Google OAuth. Google connections additionally require `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as protected Worker configuration.

## Stripe webhooks

Create one Stripe webhook endpoint at:

```text
https://<your-worker-host>/api/stripe/webhook
```

Subscribe to `checkout.session.completed` and `checkout.session.expired`.

No Stripe Product or Price ID is required for the $10 carousel or rank payments. The Worker creates one-time Checkout line items dynamically and records the resulting session ID in D1.

## Escrow webhook

Register this URL with Escrow.com after setting `ESCROW_WEBHOOK_SECRET`:

```text
https://<your-worker-host>/api/escrow/webhook?secret=<your-webhook-secret>
```

The endpoint rejects requests without the secret, then fetches the referenced transaction from Escrow.com before changing the local deal status. The incoming event name is never trusted as the financial state.

## Provider boundaries

Stripe handles BidLadders' own visibility payments only. It is not the acquisition escrow account and the app does not send a product acquisition through the $10 Checkout flow. Escrow.com handles buyer funding, inspection, disputes, and disbursement for an accepted acquisition. Provider account approval, KYC, payment-method availability, and live transaction testing remain external prerequisites.

## Local verification

```sh
pnpm run check
pnpm run build
pnpm run deploy
```
