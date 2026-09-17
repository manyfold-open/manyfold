ALTER TABLE "runtime_hosts" ADD COLUMN "storage_attempt_id" text;--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD COLUMN "storage_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD COLUMN "storage_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD COLUMN "storage_failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD CONSTRAINT "runtime_hosts_storage_attempt_lease" CHECK (("runtime_hosts"."storage_attempt_id" is null) = ("runtime_hosts"."storage_lease_until" is null));--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD CONSTRAINT "runtime_hosts_storage_failures_nonnegative" CHECK ("runtime_hosts"."storage_failure_count" >= 0);