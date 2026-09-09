ALTER TABLE "api_tokens" DROP COLUMN IF EXISTS "enforce_agent_binding";
ALTER TABLE "cli_auth_sessions" DROP CONSTRAINT IF EXISTS "cli_auth_sessions_device_code_hash_unique";
ALTER TABLE "cli_auth_sessions" DROP COLUMN IF EXISTS "requested_scopes";
ALTER TABLE "cli_auth_sessions" DROP COLUMN IF EXISTS "approved_scopes";
ALTER TABLE "cli_auth_sessions" DROP COLUMN IF EXISTS "requested_agent_id";
ALTER TABLE "cli_auth_sessions" DROP COLUMN IF EXISTS "device_code_hash";
ALTER TABLE "cli_auth_sessions" DROP COLUMN IF EXISTS "polled_at";
