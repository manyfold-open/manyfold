ALTER TABLE "users" ADD COLUMN "pending_quota_warnings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "quota_retry_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automations_quota_retry_idx" ON "automations" USING btree ("status","quota_retry_at");