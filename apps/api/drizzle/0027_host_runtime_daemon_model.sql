CREATE TABLE IF NOT EXISTS "runtime_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'enabled' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"region" text,
	"credential_ciphertext" text NOT NULL,
	"credential_key_version" integer DEFAULT 1 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_health_status" text DEFAULT 'unknown' NOT NULL,
	"last_health_message" text,
	"last_health_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "host_daemons" (
	"host_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"daemon_uuid" text NOT NULL,
	"token_id" text,
	"hostname" text,
	"os" text,
	"arch" text,
	"cli_version" text,
	"herdr_version" text,
	"startup_method" text,
	"client_features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"terminal_pty" boolean,
	"detected_frameworks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_ip" text,
	"rpc_instance_id" text,
	"rpc_connection_token" text,
	"rpc_inbox" text,
	"rpc_connected_at" timestamp with time zone,
	"rpc_last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "runtime_providers" ("id","kind","name","status","priority","region","credential_ciphertext","credential_key_version","config","last_health_status","created_at","updated_at")
SELECT "id", 'sprites', "slug", "status", "priority", NULL, "token_ciphertext", "token_key_version",
    jsonb_build_object('orgSlug', "org_slug", 'orgId', "org_id", 'tokenId', "token_id", 'notes', "notes"),
    'unknown', "created_at", "updated_at"
FROM "sprites_accounts";
--> statement-breakpoint
INSERT INTO "runtime_providers" ("id","kind","name","status","priority","region","credential_ciphertext","credential_key_version","config","last_health_status","last_health_message","last_health_checked_at","created_at","updated_at")
SELECT "id", 'k8s', "name", 'enabled', "priority", "region", "kubeconfig_ciphertext", "kubeconfig_key_version",
    jsonb_build_object('description', "description", 'hostSuffix', "host_suffix"),
    COALESCE("last_health_status", 'unknown'), "last_health_message", "last_health_checked_at", "created_at", "updated_at"
FROM "k8s_clusters";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP CONSTRAINT "runtime_hosts_account_id_sprites_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP CONSTRAINT "runtime_hosts_cluster_id_k8s_clusters_id_fk";
--> statement-breakpoint
ALTER TABLE "daemon_tokens" DROP CONSTRAINT "daemon_tokens_daemon_id_runtime_hosts_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_runtimes" DROP CONSTRAINT "agent_runtimes_account_id_sprites_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_runtimes" DROP CONSTRAINT "agent_runtimes_cluster_id_k8s_clusters_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_runtimes" DROP CONSTRAINT "agent_runtimes_daemon_id_runtime_hosts_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_runtimes" DROP CONSTRAINT "agent_runtimes_host_id_runtime_hosts_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_account_id_sprites_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_cluster_id_k8s_clusters_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_daemon_id_runtime_hosts_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_host_id_runtime_hosts_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "runtime_hosts_user_uuid_unique";
--> statement-breakpoint
DROP INDEX IF EXISTS "daemon_tokens_daemon_id_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "agent_runtimes_sprite_host_framework_uq";
--> statement-breakpoint
DROP INDEX IF EXISTS "agent_runtimes_pod_host_framework_uq";
--> statement-breakpoint
DROP INDEX IF EXISTS "agent_runtimes_daemon_id_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "agents_daemon_id_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "agents_host_id_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "chat_messages_daemon_exec_ref_idx";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" ALTER COLUMN "kind" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "runtime_hosts" ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "agent_runtimes" ALTER COLUMN "status" SET DEFAULT 'installing';
--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD COLUMN "provider_id" text;
--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD COLUMN "provider_ref" jsonb;
--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD COLUMN "failure_reason" text;
--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD COLUMN "generation" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD COLUMN "power_state" text;
--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD COLUMN "power_changed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD COLUMN "keep_awake" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD COLUMN "keep_awake_lease" jsonb;
--> statement-breakpoint
ALTER TABLE "daemon_tokens" RENAME COLUMN "daemon_id" TO "host_id";
--> statement-breakpoint
ALTER TABLE "chat_messages" RENAME COLUMN "daemon_id" TO "host_id";
--> statement-breakpoint
DO $$ DECLARE n int; BEGIN
    SELECT count(*) INTO n FROM "runtime_hosts" WHERE "kind" IN ('sandbox','pod') AND COALESCE("account_id","cluster_id") IS NULL;
    IF n > 0 THEN RAISE EXCEPTION 'ADR-0036 cutover: % hosted host(s) carry no provider (account_id/cluster_id is null); repair them before migrating', n; END IF;
END $$;
--> statement-breakpoint
UPDATE "runtime_hosts" SET
    "provider_id" = CASE WHEN "kind" = 'sandbox' THEN "account_id" WHEN "kind" = 'pod' THEN "cluster_id" END,
    "provider_ref" = CASE
        WHEN "kind" = 'sandbox' THEN jsonb_build_object('kind', 'sprites', 'spriteName', "sprite_name", 'spriteId', "sprite_id")
        WHEN "kind" = 'pod' THEN jsonb_build_object('kind', 'k8s', 'namespace', "namespace", 'ingressHost', "ingress_host", 'podPhase', "pod_phase")
    END,
    "power_state" = CASE
        WHEN "kind" = 'sandbox' THEN CASE "sprite_status" WHEN 'running' THEN 'running' WHEN 'warm' THEN 'suspended' WHEN 'cold' THEN 'stopped' ELSE 'unknown' END
        WHEN "kind" = 'pod' THEN CASE WHEN "pod_phase" = 'Running' THEN 'running' ELSE 'unknown' END
    END,
    "failure_reason" = CASE WHEN "kind" = 'pod' THEN "pod_failure_reason" END
WHERE "kind" IN ('sandbox','pod');
--> statement-breakpoint
CREATE TEMP TABLE "_adr36_runner_map" AS
SELECT runner_id, parent_id, seen FROM (
    SELECT r."id" AS runner_id, s."id" AS parent_id, COALESCE(r."rpc_last_seen_at", r."last_seen_at", r."created_at") AS seen
    FROM "runtime_hosts" r
    JOIN "runtime_hosts" s ON s."user_id" = r."user_id" AND s."kind" = 'sandbox' AND r."name" = 'sprite-runner:' || s."sprite_name"
    WHERE r."kind" = 'daemon' AND r."managed" = true
    UNION ALL
    SELECT r."id", p."id", COALESCE(r."rpc_last_seen_at", r."last_seen_at", r."created_at")
    FROM "runtime_hosts" r
    JOIN "runtime_hosts" p ON p."user_id" = r."user_id" AND p."kind" = 'pod' AND r."name" = 'pod-runner:' || p."id"
    WHERE r."kind" = 'daemon' AND r."managed" = true
) m;
--> statement-breakpoint
CREATE TEMP TABLE "_adr36_runner_pick" AS
SELECT DISTINCT ON (parent_id) runner_id, parent_id FROM "_adr36_runner_map" ORDER BY parent_id, seen DESC NULLS LAST;
--> statement-breakpoint
INSERT INTO "host_daemons" ("host_id","user_id","daemon_uuid","token_id","hostname","os","arch","cli_version","herdr_version","startup_method","client_features","terminal_pty","detected_frameworks","registered_at","last_seen_at","last_ip","rpc_instance_id","rpc_connection_token","rpc_inbox","rpc_connected_at","rpc_last_seen_at","created_at","updated_at")
SELECT h."id", h."user_id", h."daemon_uuid",
    (SELECT t."id" FROM "daemon_tokens" t WHERE t."host_id" = h."id" AND t."revoked_at" IS NULL ORDER BY t."created_at" DESC LIMIT 1),
    h."hostname", h."os", h."arch", h."cli_version", h."herdr_version", h."startup_method", h."client_features", h."terminal_pty", h."detected_frameworks",
    h."created_at", h."last_seen_at", h."last_ip", h."rpc_instance_id", h."rpc_connection_token", h."rpc_inbox", h."rpc_connected_at", h."rpc_last_seen_at", h."created_at", h."updated_at"
FROM "runtime_hosts" h
WHERE h."kind" = 'daemon' AND h."managed" = false AND h."daemon_uuid" IS NOT NULL;
--> statement-breakpoint
INSERT INTO "host_daemons" ("host_id","user_id","daemon_uuid","token_id","hostname","os","arch","cli_version","herdr_version","startup_method","client_features","terminal_pty","detected_frameworks","registered_at","last_seen_at","last_ip","rpc_instance_id","rpc_connection_token","rpc_inbox","rpc_connected_at","rpc_last_seen_at","created_at","updated_at")
SELECT m.parent_id, r."user_id", r."daemon_uuid",
    (SELECT t."id" FROM "daemon_tokens" t WHERE t."host_id" = r."id" AND t."revoked_at" IS NULL ORDER BY t."created_at" DESC LIMIT 1),
    r."hostname", r."os", r."arch", r."cli_version", r."herdr_version", r."startup_method", r."client_features", r."terminal_pty", r."detected_frameworks",
    r."created_at", r."last_seen_at", r."last_ip", r."rpc_instance_id", r."rpc_connection_token", r."rpc_inbox", r."rpc_connected_at", r."rpc_last_seen_at", r."created_at", r."updated_at"
FROM "_adr36_runner_pick" m
JOIN "runtime_hosts" r ON r."id" = m.runner_id
WHERE r."daemon_uuid" IS NOT NULL;
--> statement-breakpoint
UPDATE "daemon_tokens" t SET "host_id" = m.parent_id FROM "_adr36_runner_map" m WHERE t."host_id" = m.runner_id;
--> statement-breakpoint
UPDATE "daemon_tokens" t SET "revoked_at" = COALESCE(t."revoked_at", now()), "host_id" = NULL
FROM "runtime_hosts" r WHERE t."host_id" = r."id" AND r."kind" = 'daemon' AND r."managed" = true;
--> statement-breakpoint
UPDATE "daemon_tokens" SET "revoked_at" = COALESCE("revoked_at", now()) WHERE "host_id" IS NULL AND "purpose" <> 'user';
--> statement-breakpoint
DELETE FROM "agent_runtimes" ar USING "runtime_hosts" r
WHERE ar."daemon_id" = r."id" AND r."kind" = 'daemon' AND r."managed" = true
    AND NOT EXISTS (SELECT 1 FROM "agents" a WHERE a."runtime_id" = ar."id");
--> statement-breakpoint
UPDATE "agent_runtimes" ar SET "host_id" = m.parent_id FROM "_adr36_runner_map" m WHERE ar."daemon_id" = m.runner_id AND ar."host_id" IS NULL;
--> statement-breakpoint
UPDATE "agent_runtimes" ar SET "host_id" = ar."daemon_id" FROM "runtime_hosts" r
WHERE ar."daemon_id" = r."id" AND r."kind" = 'daemon' AND r."managed" = false AND ar."host_id" IS NULL;
--> statement-breakpoint
DELETE FROM "agent_runtimes" ar USING (
    SELECT "id", row_number() OVER (PARTITION BY "host_id", "framework" ORDER BY ("status" IN ('ready','pending')) DESC, "updated_at" DESC) AS rn
    FROM "agent_runtimes" WHERE "host_id" IS NOT NULL
) d WHERE ar."id" = d."id" AND d.rn > 1 AND ar."status" IN ('failed','stopped')
    AND NOT EXISTS (SELECT 1 FROM "agents" a WHERE a."runtime_id" = ar."id");
--> statement-breakpoint
DO $$ DECLARE n int; BEGIN
    SELECT count(*) INTO n FROM "agent_runtimes" WHERE "host_id" IS NULL AND "kind" <> 'external';
    IF n > 0 THEN RAISE EXCEPTION 'ADR-0036 cutover: % non-external runtime(s) have no host; repair them before migrating', n; END IF;
    SELECT count(*) INTO n FROM (SELECT "host_id", "framework" FROM "agent_runtimes" WHERE "host_id" IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1) d;
    IF n > 0 THEN RAISE EXCEPTION 'ADR-0036 cutover: % (host, framework) pair(s) still have more than one runtime; merge them before migrating', n; END IF;
END $$;
--> statement-breakpoint
UPDATE "agent_runtimes" SET "status" = CASE "status"
    WHEN 'pending' THEN 'installing'
    WHEN 'stopped' THEN CASE WHEN "failure_reason" = 'framework not detected by daemon' THEN 'failed' ELSE 'ready' END
    ELSE "status" END;
--> statement-breakpoint
UPDATE "agents" SET "status" = CASE "status"
    WHEN 'running' THEN 'ready'
    WHEN 'stopped' THEN CASE WHEN "failure_reason" IS NULL OR "failure_reason" IN ('daemon stopped','daemon offline','daemon disconnected','daemon revoked') THEN 'ready' ELSE 'failed' END
    ELSE "status" END;
--> statement-breakpoint
UPDATE "chat_messages" c SET "host_id" = m.parent_id FROM "_adr36_runner_map" m WHERE c."host_id" = m.runner_id;
--> statement-breakpoint
UPDATE "runtime_hosts" h SET "keep_awake" = true
WHERE EXISTS (SELECT 1 FROM "agent_runtimes" ar WHERE ar."host_id" = h."id" AND ar."keep_alive_enabled" = true);
--> statement-breakpoint
DELETE FROM "runtime_hosts" WHERE "kind" = 'daemon' AND "managed" = true;
--> statement-breakpoint
UPDATE "runtime_hosts" SET
    "kind" = CASE WHEN "kind" = 'daemon' THEN 'local' ELSE 'hosted' END,
    "status" = CASE
        WHEN "kind" = 'daemon' THEN CASE WHEN "status" = 'revoked' THEN 'retired' ELSE 'ready' END
        WHEN "kind" = 'sandbox' THEN CASE WHEN "sprite_id" IS NULL THEN 'provisioning' ELSE 'ready' END
        ELSE COALESCE("pod_status", 'ready')
    END;
--> statement-breakpoint
DROP TABLE "_adr36_runner_pick";
--> statement-breakpoint
DROP TABLE "_adr36_runner_map";
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "host_daemons" ADD CONSTRAINT "host_daemons_host_id_runtime_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."runtime_hosts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "host_daemons" ADD CONSTRAINT "host_daemons_token_id_daemon_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."daemon_tokens"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "runtime_hosts" ADD CONSTRAINT "runtime_hosts_provider_id_runtime_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."runtime_providers"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daemon_tokens" ADD CONSTRAINT "daemon_tokens_host_id_runtime_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."runtime_hosts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runtimes" ADD CONSTRAINT "agent_runtimes_host_id_runtime_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."runtime_hosts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_providers_kind_name_unique" ON "runtime_providers" USING btree ("kind","name");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "host_daemons_user_uuid_unique" ON "host_daemons" USING btree ("user_id","daemon_uuid");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_hosts_user_kind_idx" ON "runtime_hosts" USING btree ("user_id","kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_hosts_provider_id_idx" ON "runtime_hosts" USING btree ("provider_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "daemon_tokens_host_id_idx" ON "daemon_tokens" USING btree ("host_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_runtimes_host_framework_uq" ON "agent_runtimes" USING btree ("host_id","framework") WHERE "agent_runtimes"."host_id" is not null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runtimes_host_id_idx" ON "agent_runtimes" USING btree ("host_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_runtime_id_idx" ON "agents" USING btree ("runtime_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_host_exec_ref_idx" ON "chat_messages" USING btree ("host_id","daemon_exec_ref") WHERE "chat_messages"."daemon_exec_ref" is not null;
--> statement-breakpoint
ALTER TABLE "sprites_accounts" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "k8s_clusters" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP TABLE "sprites_accounts" CASCADE;
--> statement-breakpoint
DROP TABLE "k8s_clusters" CASCADE;
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "daemon_uuid";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "hostname";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "os";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "arch";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "cli_version";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "herdr_version";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "startup_method";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "detected_frameworks";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "client_features";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "terminal_pty";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "last_seen_at";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "rpc_instance_id";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "rpc_connection_token";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "rpc_inbox";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "rpc_connected_at";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "rpc_last_seen_at";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "last_ip";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "account_id";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "sprite_name";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "sprite_id";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "cluster_id";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "namespace";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "ingress_host";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "pod_status";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "pod_phase";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "pod_failure_reason";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "sprite_status";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "managed";
--> statement-breakpoint
ALTER TABLE "daemon_tokens" DROP COLUMN IF EXISTS "purpose";
--> statement-breakpoint
ALTER TABLE "agent_runtimes" DROP COLUMN IF EXISTS "kind";
--> statement-breakpoint
ALTER TABLE "agent_runtimes" DROP COLUMN IF EXISTS "account_id";
--> statement-breakpoint
ALTER TABLE "agent_runtimes" DROP COLUMN IF EXISTS "sprite_name";
--> statement-breakpoint
ALTER TABLE "agent_runtimes" DROP COLUMN IF EXISTS "sprite_id";
--> statement-breakpoint
ALTER TABLE "agent_runtimes" DROP COLUMN IF EXISTS "cluster_id";
--> statement-breakpoint
ALTER TABLE "agent_runtimes" DROP COLUMN IF EXISTS "daemon_id";
--> statement-breakpoint
ALTER TABLE "agent_runtimes" DROP COLUMN IF EXISTS "home_dir";
--> statement-breakpoint
ALTER TABLE "agent_runtimes" DROP COLUMN IF EXISTS "workspace_base_dir";
--> statement-breakpoint
ALTER TABLE "agent_runtimes" DROP COLUMN IF EXISTS "last_seen_at";
--> statement-breakpoint
ALTER TABLE "agent_runtimes" DROP COLUMN IF EXISTS "namespace";
--> statement-breakpoint
ALTER TABLE "agent_runtimes" DROP COLUMN IF EXISTS "ingress_host";
--> statement-breakpoint
ALTER TABLE "agent_runtimes" DROP COLUMN IF EXISTS "keep_alive_enabled";
--> statement-breakpoint
ALTER TABLE "agent_runtimes" DROP COLUMN IF EXISTS "cpu_millicores";
--> statement-breakpoint
ALTER TABLE "agent_runtimes" DROP COLUMN IF EXISTS "memory_mb";
--> statement-breakpoint
ALTER TABLE "agent_runtimes" DROP COLUMN IF EXISTS "disk_gb";
--> statement-breakpoint
ALTER TABLE "agent_runtimes" DROP COLUMN IF EXISTS "region";
--> statement-breakpoint
ALTER TABLE "agent_runtimes" DROP COLUMN IF EXISTS "purchased_at";
--> statement-breakpoint
ALTER TABLE "agent_runtimes" DROP COLUMN IF EXISTS "started_at";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "runtime";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "sprite_status";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "k8s_pod_phase";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "account_id";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "cluster_id";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "daemon_id";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "host_id";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "sprite_name";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "sprite_id";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "namespace";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "ingress_host";
--> statement-breakpoint
ALTER TABLE "terminal_sessions" DROP COLUMN IF EXISTS "daemon_id";
--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD CONSTRAINT "runtime_hosts_provider_by_kind" CHECK (("runtime_hosts"."kind" = 'hosted') = ("runtime_hosts"."provider_id" is not null));
