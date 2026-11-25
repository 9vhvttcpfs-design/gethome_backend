-- Marketing: attach a photo/video to a post and record how each post performed.
-- Run once in the Supabase SQL editor. Safe to run again.
ALTER TABLE gx_content_items ADD COLUMN IF NOT EXISTS media_url          TEXT;
ALTER TABLE gx_content_items ADD COLUMN IF NOT EXISTS media_type         TEXT;          -- 'image' or 'video'
ALTER TABLE gx_content_items ADD COLUMN IF NOT EXISTS metrics            JSONB NOT NULL DEFAULT '{}';  -- reach, views, likes, comments, shares, saves, clicks
ALTER TABLE gx_content_items ADD COLUMN IF NOT EXISTS metrics_updated_at TIMESTAMPTZ;
