-- A machine's filesystem contract is declared by its daemon at registration
-- (ADR-0014). Before the host merge (0027) a sandbox's or cloud computer's
-- daemon registered a row of its own and the declaration lived there; 0027
-- moved the daemon onto the machine's row but not its home, so config
-- delivery, MCP import and file roots read those machines as having none.
-- A provider's image fixes the home its daemon runs under, so the home is
-- restored here. The workspace and skill roots stay unset: only a
-- registration can declare them, and their readers already fall back when
-- they are.
UPDATE "runtime_hosts" h
SET "home_dir" = CASE p."kind" WHEN 'sprites' THEN '/home/sprite' WHEN 'k8s' THEN '/home/node' END
FROM "runtime_providers" p
WHERE p."id" = h."provider_id"
    AND h."kind" = 'hosted'
    AND h."home_dir" IS NULL
    AND p."kind" IN ('sprites', 'k8s');
