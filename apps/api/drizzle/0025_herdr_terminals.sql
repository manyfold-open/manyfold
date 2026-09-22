ALTER TABLE "runtime_hosts" ADD COLUMN "herdr_version" text;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "holder_client" text;--> statement-breakpoint
ALTER TABLE "terminal_sessions" ADD COLUMN "client" text DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "terminal_sessions" ADD COLUMN "daemon_id" text;