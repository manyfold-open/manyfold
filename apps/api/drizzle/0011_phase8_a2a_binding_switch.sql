-- Prepare the retained binding column before rolling out the Phase 8 switch.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'api_tokens'
          AND column_name = 'enforce_agent_binding'
    ) THEN
        ALTER TABLE "api_tokens" ALTER COLUMN "enforce_agent_binding" SET DEFAULT false;
        -- Switch writers omit the flag. Older readers need true for A2A grants
        -- but reject personal tokens if the flag is true without an agent.
        CREATE OR REPLACE FUNCTION public.phase8_guard_legacy_binding()
        RETURNS trigger LANGUAGE plpgsql AS $binding$
        BEGIN
            IF NEW.token_kind = 'a2a-grant' THEN
                NEW.enforce_agent_binding := true;
            ELSIF NEW.agent_id IS NULL THEN
                NEW.enforce_agent_binding := false;
            END IF;
            RETURN NEW;
        END;
        $binding$;
        DROP TRIGGER IF EXISTS phase8_guard_legacy_binding ON public.api_tokens;
        CREATE TRIGGER phase8_guard_legacy_binding
            BEFORE INSERT OR UPDATE ON public.api_tokens
            FOR EACH ROW EXECUTE FUNCTION public.phase8_guard_legacy_binding();
        UPDATE "api_tokens"
        SET "enforce_agent_binding" = ("token_kind" = 'a2a-grant')
        WHERE ("token_kind" = 'a2a-grant' OR "agent_id" IS NULL)
          AND "enforce_agent_binding" IS DISTINCT FROM ("token_kind" = 'a2a-grant');
    END IF;
END $$;
