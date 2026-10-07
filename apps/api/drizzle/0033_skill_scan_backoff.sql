ALTER TABLE "skill_repo_scans" ADD COLUMN "retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skill_repo_scans" ADD COLUMN "failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_repo_scans" ADD COLUMN "failure_classification" text;--> statement-breakpoint
ALTER TABLE "skill_repo_scans" ADD CONSTRAINT "skill_repo_scans_failures_nonnegative" CHECK ("skill_repo_scans"."failure_count" >= 0);