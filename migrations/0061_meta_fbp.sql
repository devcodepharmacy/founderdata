-- The Meta browser id (the _fbp cookie a Meta pixel on the page sets) of a session with marketing consent
-- (src/worker/collect.ts). The Conversions API sends it as user_data.fbp, so Meta can match a purchase to the browser
-- that saw or clicked an ad, also when the buyer came back later without a click id. Only stored with consent, cleared
-- when consent is withdrawn and after the 28-day click window (src/worker/meta-capi.ts pruneClickUa).
-- No new row: the column rides on the session insert and the consent update.
ALTER TABLE sessions ADD COLUMN fbp TEXT;
