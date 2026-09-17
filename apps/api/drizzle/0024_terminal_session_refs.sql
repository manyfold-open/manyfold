CREATE TABLE IF NOT EXISTS "terminal_session_refs" (
	"id" text PRIMARY KEY NOT NULL,
	"terminal_id" text NOT NULL,
	"framework" text NOT NULL,
	"session_ref" text NOT NULL,
	"source" text NOT NULL,
	"cwd" text,
	"chat_session_id" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_event" text NOT NULL,
	"last_event_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"settled_outcome" text
);
--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "origin" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "terminal_session_refs" ADD CONSTRAINT "terminal_session_refs_terminal_id_terminal_sessions_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminal_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "terminal_session_refs_terminal_ref_idx" ON "terminal_session_refs" USING btree ("terminal_id","session_ref");