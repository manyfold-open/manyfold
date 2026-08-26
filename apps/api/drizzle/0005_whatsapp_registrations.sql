CREATE TABLE IF NOT EXISTS "whatsapp_registrations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"qr_content" text,
	"refresh_count" integer DEFAULT 0 NOT NULL,
	"holder_id" text,
	"error_code" text,
	"error_message" text,
	"channel_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "whatsapp_registrations" ADD CONSTRAINT "whatsapp_registrations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "whatsapp_registrations" ADD CONSTRAINT "whatsapp_registrations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "whatsapp_registrations" ADD CONSTRAINT "whatsapp_registrations_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whatsapp_registrations_user_idx" ON "whatsapp_registrations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whatsapp_registrations_expires_idx" ON "whatsapp_registrations" USING btree ("expires_at");