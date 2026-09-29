ALTER TABLE "turn_executions" ADD COLUMN "host_id" text;--> statement-breakpoint
ALTER TABLE "turn_executions" DROP COLUMN IF EXISTS "sprite_name";--> statement-breakpoint
ALTER TABLE "turn_executions" DROP COLUMN IF EXISTS "exec_session_id";