ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_stripe_customer_id_unique";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "stripe_customer_id";--> statement-breakpoint
ALTER TABLE "agent_runtimes" DROP COLUMN IF EXISTS "sku_id";
