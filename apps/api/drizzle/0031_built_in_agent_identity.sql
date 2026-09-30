-- A service framework's own agent on a sandbox or a cloud computer (Hermes'
-- `default` profile, OpenClaw's `main` agent) is stored under the framework's
-- name, and a runtime no longer points at a primary agent. Until now that
-- agent was the runtime's primary, keyed by its Manyfold id. On a sandbox an
-- agent added later is keyed by its id too, so only the one whose workspace is
-- the framework's own home is it; on a cloud computer the others are keyed by
-- a derived name and a primary was never replaced.
DO $$ DECLARE n int; BEGIN
    SELECT count(*) INTO n
    FROM "agents" a
    JOIN "agent_runtimes" r ON r."id" = a."runtime_id"
    JOIN "runtime_hosts" h ON h."id" = r."host_id" AND h."kind" = 'hosted'
    LEFT JOIN "runtime_providers" p ON p."id" = h."provider_id"
    WHERE r."framework" IN ('hermes', 'openclaw')
        AND a."id" = r."primary_agent_id"
        AND a."internal_id" = a."id"
        AND (a."workspace_path" = r."mount_path" OR p."kind" = 'k8s')
        AND EXISTS (
            SELECT 1 FROM "agents" b
            WHERE b."runtime_id" = r."id"
                AND b."internal_id" = CASE r."framework" WHEN 'hermes' THEN 'default' ELSE 'main' END
        );
    IF n > 0 THEN RAISE EXCEPTION 'built-in agent identity: % runtime(s) hold a second row for the framework''s own agent beside their primary; delete that row before migrating', n; END IF;
END $$;
--> statement-breakpoint
UPDATE "agents" a
SET "internal_id" = CASE r."framework" WHEN 'hermes' THEN 'default' ELSE 'main' END
FROM "agent_runtimes" r
JOIN "runtime_hosts" h ON h."id" = r."host_id" AND h."kind" = 'hosted'
LEFT JOIN "runtime_providers" p ON p."id" = h."provider_id"
WHERE r."id" = a."runtime_id"
    AND r."framework" IN ('hermes', 'openclaw')
    AND a."id" = r."primary_agent_id"
    AND a."internal_id" = a."id"
    AND (a."workspace_path" = r."mount_path" OR p."kind" = 'k8s');
--> statement-breakpoint
ALTER TABLE "runtime_hosts" DROP COLUMN IF EXISTS "primary_agent_id";--> statement-breakpoint
ALTER TABLE "agent_runtimes" DROP COLUMN IF EXISTS "primary_agent_id";
