-- Attribution that outlives the visit, and visitors joined by identify() (src/worker/payments.ts, docs/PRIVACY.md).
--   payments.channel, payments.source, payments.campaign
--                               a copy of the credited visit's channel, source and utm_campaign, written by the same
--                               insert or update that sets session_id, so a payment costs no extra row. Visits are
--                               deleted after RETENTION_MONTHS; the payment then keeps its source in the breakdowns
--                               instead of falling into "No source". The UPDATE below fills the rows stored before.
--   visitors_email, visitors_user
--                               every visitor of a site that identify() (or a payment) gave the same email or user id,
--                               so a purchase is credited to the visit that brought the person on an earlier day, and
--                               POST /api/v1/goals finds a visitor by email or user_id. Partial: only identified
--                               visitors are in them. Writes 1 more row when a visitor first gets an email, and 1 more
--                               when it first gets a user id.
ALTER TABLE payments ADD COLUMN channel TEXT;
ALTER TABLE payments ADD COLUMN source TEXT;
ALTER TABLE payments ADD COLUMN campaign TEXT;
UPDATE payments SET (channel, source, campaign) = (
  SELECT s.channel, s.source, s.utm_campaign FROM sessions s WHERE s.site_id = payments.site_id AND s.id = payments.session_id
)
WHERE session_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM sessions s WHERE s.site_id = payments.site_id AND s.id = payments.session_id);
CREATE INDEX visitors_email ON visitors (site_id, email) WHERE email IS NOT NULL;
CREATE INDEX visitors_user ON visitors (site_id, user_id) WHERE user_id IS NOT NULL;
-- Dodo subscriptions built from their first payments (subscription-metrics.ts backfillSubscriptions) never saw a later
-- payment, so they lapsed on paper 61 days after the first one. Each now moves to its last payment, paid until one
-- period after it. The webhook keeps them current from here on (src/worker/dodo.ts).
WITH last AS (
  SELECT site_id, subscription_id, MAX(ts) AS ts FROM payments
  WHERE provider = 'dodo' AND kind = 'payment' AND subscription_id IS NOT NULL GROUP BY 1, 2
)
UPDATE subscriptions SET
  rev = rev + 1,
  renewed_at = last.ts,
  expires_at = MAX(COALESCE(subscriptions.expires_at, 0), last.ts
    + COALESCE(subscriptions.interval_count, 1) * CASE subscriptions.interval WHEN 'year' THEN 31536000000 WHEN 'week' THEN 604800000 WHEN 'day' THEN 86400000 ELSE 2630016000 END)
FROM last
WHERE subscriptions.provider = 'dodo' AND subscriptions.ended_at IS NULL
  AND last.site_id = subscriptions.site_id AND last.subscription_id = subscriptions.id
  AND last.ts > COALESCE(subscriptions.renewed_at, 0);
