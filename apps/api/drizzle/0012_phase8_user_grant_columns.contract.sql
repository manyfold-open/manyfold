-- Apply only after every API instance runs the Phase 8 switch release.
-- Deploy the 0011 A2A binding preparation separately before this contract.
-- Rollback after this contract must keep that switch's schema-compatible code.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM "api_tokens"
        WHERE "token_kind" = 'user-grant' AND "agent_id" IS NOT NULL
          AND "revoked_at" IS NULL
          AND ("expires_at" IS NULL OR "expires_at" > now())
    ) THEN
        RAISE EXCEPTION 'Phase 8 contract requires all agent user-grants to be retired';
    END IF;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS phase8_guard_legacy_binding ON public.api_tokens;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.phase8_guard_legacy_binding();
--> statement-breakpoint
-- This token kind has no producer and is rejected by the switch verifier.
DELETE FROM "token_credentials"
WHERE "token_hash" IN (
    SELECT "token_hash" FROM "api_tokens" WHERE "token_kind" = 'a2a-ephemeral'
);
--> statement-breakpoint
ALTER TABLE "cli_auth_sessions" DROP CONSTRAINT IF EXISTS "cli_auth_sessions_device_code_hash_unique";--> statement-breakpoint
ALTER TABLE "cli_auth_sessions" DROP CONSTRAINT IF EXISTS "cli_auth_sessions_requested_agent_id_agents_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "api_tokens_agent_id_active_uq";--> statement-breakpoint
ALTER TABLE "api_tokens" DROP COLUMN IF EXISTS "enforce_agent_binding";--> statement-breakpoint
ALTER TABLE "cli_auth_sessions" DROP COLUMN IF EXISTS "requested_scopes";--> statement-breakpoint
ALTER TABLE "cli_auth_sessions" DROP COLUMN IF EXISTS "approved_scopes";--> statement-breakpoint
ALTER TABLE "cli_auth_sessions" DROP COLUMN IF EXISTS "requested_agent_id";--> statement-breakpoint
ALTER TABLE "cli_auth_sessions" DROP COLUMN IF EXISTS "device_code_hash";--> statement-breakpoint
ALTER TABLE "cli_auth_sessions" DROP COLUMN IF EXISTS "polled_at";
