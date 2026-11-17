-- Why DataForSEO refused a hosted App Store check (src/worker/aso-hosted.ts). A refused pair keeps task_id NULL and
-- gets task_day = the day it was refused, so it is tried again the next UTC day, not at every run. NULL for a pair that
-- was posted, collected or never refused. The ASO tab shows the message per country.
ALTER TABLE aso_rank_tasks ADD COLUMN error TEXT;
