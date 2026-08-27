# BidLadders Escrow

## Current implementation

BidLadders uses Escrow.com as a configuration-gated third-party provider. The Worker creates an Escrow.com transaction only after a seller accepts a deal. The transaction contains:

- one `general_merchandise` item for the software/product transfer;
- a three-day buyer inspection period;
- Escrow.com fees split equally between buyer and seller;
- a `partner_fee` item for the BidLadders marketplace fee using the current tiers: 8% below $10,000, 3.5% from $10,000 to below $50,000, and 1.7% from $50,000 upward.

The buyer and seller must each save a contact email under Profile. BidLadders stores the Escrow transaction ID and status on the private deal record. The provider, not BidLadders, receives and disburses the acquisition funds.

## Worker setup

Create an Escrow.com account, request API access/partner approval, and test in the Escrow.com sandbox first. Add these as Worker secrets; never put them in `wrangler.jsonc`, source files, or the browser:

```text
ESCROW_API_EMAIL
ESCROW_API_KEY
```

For sandbox testing, add the non-secret variable `ESCROW_API_BASE_URL` with:

```text
https://api.escrow-sandbox.com/2017-09-01
```

Production uses `https://api.escrow.com/2017-09-01` by default. Apply migration `0008_escrow_and_contact_email.sql` before enabling the endpoint.

## Deal flow

1. Buyer completes buyer onboarding and sends an offer.
2. Buyer and seller negotiate in the private room.
3. Seller clicks **Accept deal**.
4. Either party clicks **Start escrow**. The Worker creates one Escrow.com transaction and prevents a second transaction for the same deal.
5. Buyer and seller agree to the Escrow.com terms, buyer funds the transaction, seller transfers the agreed product assets, and buyer inspects them.
6. Buyer accepts the delivered product in Escrow.com. Escrow.com disburses the sale amount to the seller and the partner fee to BidLadders after its process and fees.

The current MVP does not decide whether code, domains, accounts, data, or customer contracts have transferred. The deal room must record the exact asset list, transfer method, representations, inspection period, and dispute terms before escrow is started.

## Stripe boundary

The existing Stripe account is for BidLadders' own $10 spot and rank payments. It is not the acquisition escrow account. Do not send a $5,000,000 acquisition through that Checkout flow. If Stripe is later used for marketplace payments instead of Escrow.com, Connect onboarding, seller verification, payout, refunds, disputes, tax, and negative-balance responsibilities must be designed separately.
