-- Apple's commission for the "After Apple's cut" amounts (src/worker/commission.ts, docs/GUIDE.md "Apple's cut"):
-- 15 (App Store Small Business Program, the default) or 30. Used for a product until the App Store Connect sales
-- import has Apple's own proceeds for it.
ALTER TABLE sites ADD COLUMN app_commission INTEGER NOT NULL DEFAULT 15;
