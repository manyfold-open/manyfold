-- Switch release: refuse an unprepared deployment before any data is changed.
-- Column drops follow only after this API is running on every instance.
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM "api_tokens"
        WHERE "token_kind" = 'user-grant' AND "agent_id" IS NOT NULL
          AND "revoked_at" IS NULL
          AND ("expires_at" IS NULL OR "expires_at" > now())
    ) THEN
        RAISE EXCEPTION 'Phase 8 requires migrating and revoking active agent user-grant bearers before upgrade';
    END IF;
    IF EXISTS (
        SELECT 1 FROM "agent_runtime_tokens"
        WHERE "revoked_at" IS NULL
          AND ("token_ciphertext" IS NULL OR "token_key_version" IS NULL)
    ) THEN
        RAISE EXCEPTION 'Phase 8 requires encrypted copies of all active runtime identities before upgrade';
    END IF;
    IF EXISTS (
        SELECT 1 FROM "cli_auth_sessions"
        WHERE "requested_scopes" IS NOT NULL AND "expires_at" > now()
    ) THEN
        RAISE EXCEPTION 'Phase 8 requires the retired CLI grant sessions to expire before upgrade';
    END IF;
END $$;
--> statement-breakpoint
DELETE FROM "cli_auth_sessions" WHERE "requested_scopes" IS NOT NULL;
