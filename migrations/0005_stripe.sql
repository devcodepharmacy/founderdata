-- Stripe webhook signing secret (whsec_...), one per site, set in Settings.
ALTER TABLE sites ADD COLUMN stripe_webhook_secret TEXT;
