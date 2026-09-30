CREATE TABLE IF NOT EXISTS "agent_create_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"name" text NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"step" text,
	"host_id" text,
	"runtime_id" text,
	"agent_id" text,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_create_requests" ADD CONSTRAINT "agent_create_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_create_requests_in_progress_name_uq" ON "agent_create_requests" USING btree ("user_id","name") WHERE "agent_create_requests"."status" = 'in_progress';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_create_requests_user_updated_idx" ON "agent_create_requests" USING btree ("user_id","updated_at");