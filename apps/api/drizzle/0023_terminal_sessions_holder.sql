CREATE TABLE IF NOT EXISTS "terminal_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"runtime" text NOT NULL,
	"host_id" text,
	"runtime_id" text,
	"held_session_id" text,
	"process_handle" text,
	"token_id" text,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_reason" text,
	CONSTRAINT "terminal_sessions_ended_pair" CHECK (("terminal_sessions"."ended_at" is null) = ("terminal_sessions"."ended_reason" is null))
);
--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "holder_terminal_id" text;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "holder_acquired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "import_pending_since" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "terminal_sessions" ADD CONSTRAINT "terminal_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "terminal_sessions" ADD CONSTRAINT "terminal_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "terminal_sessions" ADD CONSTRAINT "terminal_sessions_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."api_tokens"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "terminal_sessions_live_lease_idx" ON "terminal_sessions" USING btree ("lease_expires_at") WHERE "terminal_sessions"."ended_at" is null;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_turn_xor_holder" CHECK ("chat_sessions"."inflight_message_id" is null or "chat_sessions"."holder_terminal_id" is null);--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_holder_pair" CHECK (("chat_sessions"."holder_terminal_id" is null) = ("chat_sessions"."holder_acquired_at" is null));