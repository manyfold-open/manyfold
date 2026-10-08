ALTER TABLE "runtime_hosts" ADD COLUMN "health_status" text;--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD COLUMN "health_reason" text;--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD COLUMN "health_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD COLUMN "health_check_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD COLUMN "health_check_lease_until" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD COLUMN "health_check_next_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD COLUMN "health_failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD COLUMN "maintenance_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD CONSTRAINT "runtime_hosts_health_failures_nonnegative" CHECK ("runtime_hosts"."health_failure_count" >= 0);