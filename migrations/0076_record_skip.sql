-- Pages that are never recorded (docs/GUIDE.md, "People and recordings (Pro)"; docs/PRIVACY.md, "Recordings").
--   record_skip  path prefixes, one per line, such as /dashboard or /account. A page whose path is a prefix or starts
--                with prefix + "/" is never recorded, and the tracker sends no clicks or errors from it. At most 20
--                prefixes of up to 100 characters (src/worker/recording.ts). NULL = every page can be recorded.
ALTER TABLE sites ADD COLUMN record_skip TEXT;
