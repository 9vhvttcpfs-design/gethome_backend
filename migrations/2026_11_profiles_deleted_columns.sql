-- Account deletion (POST /api/customer/delete-account) marks the profile with these two columns.
-- Without them its whole update fails, so personal details are not removed. Additive and safe to re-run.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
