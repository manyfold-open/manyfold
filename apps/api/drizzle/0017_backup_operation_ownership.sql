ALTER TABLE "agent_backup_restores" ADD COLUMN "operation_key" text;--> statement-breakpoint
ALTER TABLE "agent_backup_restores" ADD COLUMN "operation_released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_backups" ADD COLUMN "operation_key" text;--> statement-breakpoint
ALTER TABLE "agent_backups" ADD COLUMN "operation_released_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_backup_restores_operation_idx" ON "agent_backup_restores" USING btree ("operation_key") WHERE "agent_backup_restores"."operation_key" is not null and "agent_backup_restores"."operation_released_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_backups_operation_idx" ON "agent_backups" USING btree ("operation_key") WHERE "agent_backups"."operation_key" is not null and "agent_backups"."operation_released_at" is null;