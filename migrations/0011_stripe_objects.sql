-- Stripe objects behind each payment (src/worker/stripe.ts). One Stripe payment reaches Revtrail through several
-- events, and since API 2025-03-31 an invoice no longer names its PaymentIntent. Every PaymentIntent, charge, invoice
-- and Checkout Session id seen for a payment points at that payment here, so each payment is stored once whatever
-- id an event carries. Refunds and disputes keep their state here, so a failed refund or a won dispute comes back.
CREATE TABLE stripe_objects (
  id TEXT PRIMARY KEY,         -- pi_, ch_ or py_, in_, cs_, re_ or pyr_, dp_ or du_
  site_id TEXT NOT NULL,       -- the site that received it
  payment_id TEXT NOT NULL,    -- payments.id of the payment it belongs to (may not exist yet)
  charge TEXT,                 -- refunds: the charge they belong to
  amount INTEGER,              -- charges: amount_refunded at `at`; refunds and disputes: their amount (Stripe minor units)
  status TEXT,                 -- refunds and disputes: Stripe's status
  at INTEGER                   -- event time of `amount` and `status`, ms
) WITHOUT ROWID;
CREATE INDEX stripe_objects_payment ON stripe_objects (payment_id);
CREATE INDEX stripe_objects_charge ON stripe_objects (charge);

-- Several sites can share one Stripe account; each has its own endpoint and gets every event. A payment that names no
-- site (rt_site_id) and that nothing else ties to a site is recorded only by sites with this on (the default).
ALTER TABLE sites ADD COLUMN stripe_unpinned INTEGER NOT NULL DEFAULT 1;
