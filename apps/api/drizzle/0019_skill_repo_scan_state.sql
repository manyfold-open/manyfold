CREATE TABLE IF NOT EXISTS "skill_repo_scans" (
	"key" text PRIMARY KEY NOT NULL,
	"revision" text,
	"snapshot" jsonb,
	"published_aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scanned_at" timestamp with time zone,
	"holder_id" text,
	"generation" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
