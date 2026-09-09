CREATE TABLE IF NOT EXISTS "runtime_auth_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"runtime_id" text NOT NULL,
	"framework" text NOT NULL,
	"label" text NOT NULL,
	"auth_method" text NOT NULL,
	"lifecycle" text DEFAULT 'pending' NOT NULL,
	"credential_status" text DEFAULT 'unknown' NOT NULL,
	"credential_generation" integer DEFAULT 0 NOT NULL,
	"vendor" text,
	"vendor_user_id" text,
	"vendor_account_id" text,
	"email" text,
	"display_name" text,
	"organization" text,
	"plan" text,
	"checked_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "runtime_auth_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"runtime_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"request_id" text,
	"result_code" text,
	"error" text,
	"revoke" text,
	"deadline_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runtimes" ADD COLUMN "default_auth_profile_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "runtime_auth_profile_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "runtime_auth_binding_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "runtime_auth_profiles" ADD CONSTRAINT "runtime_auth_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "runtime_auth_profiles" ADD CONSTRAINT "runtime_auth_profiles_runtime_id_agent_runtimes_id_fk" FOREIGN KEY ("runtime_id") REFERENCES "public"."agent_runtimes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "runtime_auth_operations" ADD CONSTRAINT "runtime_auth_operations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "runtime_auth_operations" ADD CONSTRAINT "runtime_auth_operations_runtime_id_agent_runtimes_id_fk" FOREIGN KEY ("runtime_id") REFERENCES "public"."agent_runtimes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "runtime_auth_operations" ADD CONSTRAINT "runtime_auth_operations_profile_id_runtime_auth_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."runtime_auth_profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_auth_profiles_runtime_idx" ON "runtime_auth_profiles" USING btree ("runtime_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_auth_profiles_runtime_id_id_uq" ON "runtime_auth_profiles" USING btree ("runtime_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_auth_operations_profile_idx" ON "runtime_auth_operations" USING btree ("profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_auth_operations_profile_kind_request_uq" ON "runtime_auth_operations" USING btree ("profile_id","kind","request_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents" ADD CONSTRAINT "agents_runtime_auth_profile_id_runtime_auth_profiles_id_fk" FOREIGN KEY ("runtime_auth_profile_id") REFERENCES "public"."runtime_auth_profiles"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_runtime_auth_profile_idx" ON "agents" USING btree ("runtime_auth_profile_id");