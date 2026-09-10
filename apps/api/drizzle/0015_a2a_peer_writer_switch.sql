-- Deploy the prepared writer to every API instance before this switch.
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
          AND l.revoked_at IS NULL AND (p.id IS NULL OR p.revoked_at IS NOT NULL)
    ) THEN
        RAISE EXCEPTION 'a2a_peer_writer_switch: preparation is incomplete';
    END IF;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS mf_a2a_peer_identity_compat ON public.a2a_agent_grants;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.mf_a2a_peer_identity_compat();
