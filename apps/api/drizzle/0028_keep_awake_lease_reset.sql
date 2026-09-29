-- The keep-awake switch now holds its machine with a platform task the API
-- renews (ADR-0038), recorded as {expiresAt, verifiedAt, lastError}. The in-VM
-- lease loop's bookkeeping means nothing in that shape; a host whose switch is
-- on is held again on the next reconcile.
UPDATE "runtime_hosts" SET "keep_awake_lease" = NULL WHERE "keep_awake_lease" IS NOT NULL;
