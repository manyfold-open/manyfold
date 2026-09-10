-- Prepare one peer-policy authority without changing existing public grant IDs.
-- Readers remain available while the two small grant tables reject writers.
LOCK TABLE public.api_tokens, public.a2a_agent_grants IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.a2a_agent_grants p
        JOIN public.agents caller ON caller.id = p.caller_agent_id
        JOIN public.agents target ON target.id = p.target_agent_id
        WHERE p.revoked_at IS NULL
          AND (caller.user_id <> p.user_id OR target.user_id <> p.user_id)
    ) OR EXISTS (
        SELECT 1 FROM public.api_tokens l
        JOIN public.agents caller ON caller.id = l.caller_agent_id
        JOIN public.agents target ON target.id = l.agent_id
        WHERE l.token_kind = 'a2a-grant' AND l.caller_agent_id IS NOT NULL
          AND l.revoked_at IS NULL
          AND (caller.user_id <> l.user_id OR target.user_id <> l.user_id)
    ) THEN
        RAISE EXCEPTION 'a2a_peer_authority: inconsistent grant ownership';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.a2a_agent_grants p
        JOIN public.api_tokens l ON l.user_id = p.user_id
            AND l.caller_agent_id = p.caller_agent_id AND l.agent_id = p.target_agent_id
            AND l.token_kind = 'a2a-grant'
        WHERE p.revoked_at IS NULL AND l.revoked_at IS NULL
          AND (p.expires_at IS DISTINCT FROM l.expires_at
               OR NOT (p.scopes @> l.scopes AND p.scopes <@ l.scopes))
    ) THEN
        RAISE EXCEPTION 'a2a_peer_authority: conflicting active grant policy';
    END IF;
END $$;
--> statement-breakpoint
-- A generic token revoke used to leave its typed policy active. Honor the
-- latest revocation only when there is no newer live legacy grant for the pair.
WITH latest AS (
    SELECT DISTINCT ON (user_id, agent_id, caller_agent_id) *
    FROM public.api_tokens
    WHERE token_kind = 'a2a-grant' AND caller_agent_id IS NOT NULL
    ORDER BY user_id, agent_id, caller_agent_id,
             (revoked_at IS NULL) DESC, created_at DESC, id DESC
), repaired AS (
    UPDATE public.a2a_agent_grants p SET revoked_at = l.revoked_at
    FROM latest l
    WHERE p.user_id = l.user_id AND p.caller_agent_id = l.caller_agent_id
      AND p.target_agent_id = l.agent_id AND p.revoked_at IS NULL
      AND l.revoked_at IS NOT NULL AND l.revoked_at >= p.created_at
      AND p.expires_at IS NOT DISTINCT FROM l.expires_at
      AND p.scopes @> l.scopes AND p.scopes <@ l.scopes
    RETURNING p.id, p.user_id, p.caller_agent_id, p.target_agent_id,
              l.id AS legacy_id, l.revoked_at
)
INSERT INTO public.audit_logs (id, action, subject, meta)
SELECT gen_random_uuid()::text, 'grant.revoked', id,
       jsonb_build_object('reason', 'a2a-peer-authority-reconciliation',
                          'userId', user_id, 'callerAgentId', caller_agent_id,
                          'agentId', target_agent_id, 'legacyTokenId', legacy_id,
                          'revokedAt', revoked_at)
FROM repaired;
--> statement-breakpoint
-- The inverse drift must not be backfilled into a new authorization either.
WITH latest AS (
    SELECT DISTINCT ON (user_id, target_agent_id, caller_agent_id) *
    FROM public.a2a_agent_grants
    ORDER BY user_id, target_agent_id, caller_agent_id,
             (revoked_at IS NULL) DESC, created_at DESC, id DESC
)
UPDATE public.api_tokens l SET revoked_at = p.revoked_at
FROM latest p
WHERE l.user_id = p.user_id AND l.caller_agent_id = p.caller_agent_id
  AND l.agent_id = p.target_agent_id AND l.token_kind = 'a2a-grant'
  AND l.revoked_at IS NULL AND p.revoked_at IS NOT NULL
  AND p.revoked_at >= l.created_at
  AND p.expires_at IS NOT DISTINCT FROM l.expires_at
  AND p.scopes @> l.scopes AND p.scopes <@ l.scopes;
--> statement-breakpoint
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.a2a_agent_grants p
        JOIN LATERAL (
            SELECT revoked_at FROM public.api_tokens l
            WHERE l.token_kind = 'a2a-grant' AND l.user_id = p.user_id
              AND l.agent_id = p.target_agent_id AND l.caller_agent_id = p.caller_agent_id
            ORDER BY (l.revoked_at IS NULL) DESC, l.created_at DESC, l.id DESC LIMIT 1
        ) l ON true
        WHERE p.revoked_at IS NULL AND l.revoked_at >= p.created_at
    ) OR EXISTS (
        SELECT 1 FROM public.api_tokens l
        JOIN LATERAL (
            SELECT revoked_at FROM public.a2a_agent_grants p
            WHERE p.user_id = l.user_id AND p.target_agent_id = l.agent_id
              AND p.caller_agent_id = l.caller_agent_id
            ORDER BY (p.revoked_at IS NULL) DESC, p.created_at DESC, p.id DESC LIMIT 1
        ) p ON true
        WHERE l.token_kind = 'a2a-grant' AND l.caller_agent_id IS NOT NULL
          AND l.revoked_at IS NULL AND p.revoked_at >= l.created_at
    ) THEN
        RAISE EXCEPTION 'a2a_peer_authority: conflicting revoked grant history';
    END IF;
END $$;
--> statement-breakpoint
UPDATE public.a2a_agent_grants p SET
    id = l.id,
    name = l.name,
    created_at = l.created_at,
    last_used_at = greatest(p.last_used_at, l.last_used_at)
FROM public.api_tokens l
WHERE l.token_kind = 'a2a-grant' AND l.caller_agent_id IS NOT NULL
  AND l.user_id = p.user_id AND l.agent_id = p.target_agent_id
  AND l.caller_agent_id = p.caller_agent_id
  AND l.revoked_at IS NULL AND p.revoked_at IS NULL;
--> statement-breakpoint
INSERT INTO public.a2a_agent_grants
    (id, user_id, caller_agent_id, target_agent_id, scopes, name,
     created_at, expires_at, last_used_at)
SELECT l.id, l.user_id, l.caller_agent_id, l.agent_id, l.scopes, l.name,
       l.created_at, l.expires_at, l.last_used_at
FROM public.api_tokens l
WHERE l.token_kind = 'a2a-grant' AND l.caller_agent_id IS NOT NULL
  AND l.revoked_at IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM public.a2a_agent_grants p
      WHERE p.user_id = l.user_id AND p.caller_agent_id = l.caller_agent_id
        AND p.target_agent_id = l.agent_id AND p.revoked_at IS NULL
  );
--> statement-breakpoint
-- Old instances still insert a random policy ID after creating the API row.
-- Remove this trigger only after every writer uses the prepared stable ID.
CREATE OR REPLACE FUNCTION public.mf_a2a_peer_identity_compat()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    legacy_id text;
BEGIN
    IF NEW.revoked_at IS NULL THEN
        SELECT id INTO legacy_id FROM public.api_tokens
        WHERE user_id = NEW.user_id AND agent_id = NEW.target_agent_id
          AND caller_agent_id = NEW.caller_agent_id AND token_kind = 'a2a-grant'
          AND revoked_at IS NULL;
        IF FOUND THEN NEW.id := legacy_id; END IF;
    END IF;
    RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS mf_a2a_peer_identity_compat ON public.a2a_agent_grants;
--> statement-breakpoint
CREATE TRIGGER mf_a2a_peer_identity_compat
BEFORE INSERT ON public.a2a_agent_grants
FOR EACH ROW EXECUTE FUNCTION public.mf_a2a_peer_identity_compat();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mf_a2a_peer_revoke_compat()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.token_kind = 'a2a-grant' AND OLD.caller_agent_id IS NOT NULL
       AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
        UPDATE public.a2a_agent_grants SET revoked_at = NEW.revoked_at
        WHERE id = OLD.id AND user_id = OLD.user_id
          AND caller_agent_id = OLD.caller_agent_id AND target_agent_id = OLD.agent_id
          AND revoked_at IS NULL;
    END IF;
    RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS mf_a2a_peer_revoke_compat ON public.api_tokens;
--> statement-breakpoint
CREATE TRIGGER mf_a2a_peer_revoke_compat
AFTER UPDATE OF revoked_at ON public.api_tokens
FOR EACH ROW EXECUTE FUNCTION public.mf_a2a_peer_revoke_compat();
