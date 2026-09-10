-- Every API instance must run the canonical writer before this contract.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
LOCK TABLE public.api_tokens, public.a2a_agent_grants IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.api_tokens l
        LEFT JOIN public.a2a_agent_grants p ON p.id = l.id
            AND p.user_id = l.user_id AND p.target_agent_id = l.agent_id
            AND p.caller_agent_id = l.caller_agent_id
        WHERE l.token_kind = 'a2a-grant' AND l.caller_agent_id IS NOT NULL
          AND l.revoked_at IS NULL AND p.id IS NULL
    ) THEN
        RAISE EXCEPTION 'a2a_peer_contract: unmigrated peer credential';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.api_tokens
        WHERE token_kind = 'a2a-grant' AND caller_agent_id IS NOT NULL
          AND revoked_at IS NULL AND last_used_at > now() - interval '30 days'
    ) THEN
        RAISE EXCEPTION 'a2a_peer_contract: recently used caller-bound credential';
    END IF;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS mf_a2a_peer_revoke_compat ON public.api_tokens;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.mf_a2a_peer_revoke_compat();
--> statement-breakpoint
-- Deleting the credential parent cascades to its API mirror. Runtime
-- identities belong to a different credential kind and are never selected.
DELETE FROM public.token_credentials credential
USING public.api_tokens token
WHERE credential.token_hash = token.token_hash AND credential.kind = 'external'
  AND token.token_kind = 'a2a-grant' AND token.caller_agent_id IS NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.api_tokens
        WHERE token_kind = 'a2a-grant' AND caller_agent_id IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'a2a_peer_contract: peer credential cleanup incomplete';
    END IF;
END $$;
