CREATE TABLE IF NOT EXISTS "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"role" text DEFAULT 'user' NOT NULL,
	"stateful_sandbox_limit" integer DEFAULT 1 NOT NULL,
	"persistent_runtime_limit" integer DEFAULT 0 NOT NULL,
	"active_hours_bonus" integer DEFAULT 0 NOT NULL,
	"plan_id" text DEFAULT 'free' NOT NULL,
	"last_quota_warnings_at" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"framework_runtime_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stripe_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_stripe_customer_id_unique" UNIQUE("stripe_customer_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"max_agents_provisioned" integer NOT NULL,
	"max_concurrent_active" integer NOT NULL,
	"max_storage_gb" integer NOT NULL,
	"monthly_active_hours_included" integer,
	"max_always_online_runtimes" integer DEFAULT 0 NOT NULL,
	"max_always_online_agents" integer DEFAULT 0 NOT NULL,
	"max_channels" integer DEFAULT 0 NOT NULL,
	"max_automations" integer DEFAULT 0 NOT NULL,
	"max_automation_runs_monthly" integer,
	"message_history_retention_days" integer,
	"monthly_api_request_limit" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_identities" (
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_identities_provider_subject_pk" PRIMARY KEY("provider","subject")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_passwords" (
	"user_id" text PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_avatars" (
	"user_id" text PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"user_agent" text,
	"ip" text,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"purpose" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_states" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"state_hash" text NOT NULL,
	"code_verifier" text NOT NULL,
	"redirect_after" text,
	"link_user_id" text,
	"link_session_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_states_state_hash_unique" UNIQUE("state_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sprites_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"org_slug" text NOT NULL,
	"org_id" text NOT NULL,
	"token_id" text NOT NULL,
	"token_ciphertext" text NOT NULL,
	"token_key_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'enabled' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sprites_accounts_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "k8s_clusters" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kubeconfig_ciphertext" text NOT NULL,
	"kubeconfig_key_version" integer DEFAULT 1 NOT NULL,
	"host_suffix" text,
	"region" text,
	"last_health_status" text DEFAULT 'unknown' NOT NULL,
	"last_health_message" text,
	"last_health_checked_at" timestamp with time zone,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "k8s_clusters_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "runtime_hosts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text DEFAULT 'daemon' NOT NULL,
	"daemon_uuid" text,
	"name" text NOT NULL,
	"hostname" text,
	"os" text,
	"arch" text,
	"cli_version" text,
	"startup_method" text,
	"home_dir" text,
	"workspace_base_dir" text,
	"skills_dir" text,
	"detected_frameworks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"client_features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"terminal_pty" boolean,
	"last_seen_at" timestamp with time zone,
	"rpc_instance_id" text,
	"rpc_inbox" text,
	"rpc_connected_at" timestamp with time zone,
	"rpc_last_seen_at" timestamp with time zone,
	"last_ip" text,
	"status" text DEFAULT 'active' NOT NULL,
	"account_id" text,
	"sprite_name" text,
	"sprite_id" text,
	"primary_agent_id" text,
	"sprite_status" text,
	"terminal_enabled" boolean DEFAULT false NOT NULL,
	"emptied_at" timestamp with time zone,
	"exec_cooldown_until" timestamp with time zone,
	"active_accrual_since" timestamp (3) with time zone,
	"storage_bytes" bigint,
	"storage_measured_at" timestamp with time zone,
	"storage_breakdown" jsonb,
	"managed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "daemon_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"daemon_id" text,
	"name" text NOT NULL,
	"purpose" text DEFAULT 'user' NOT NULL,
	"token_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daemon_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_runtimes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"framework" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"current_phase" text,
	"failure_reason" text,
	"account_id" text,
	"sprite_name" text,
	"sprite_id" text,
	"cluster_id" text,
	"daemon_id" text,
	"host_id" text,
	"home_dir" text,
	"workspace_base_dir" text,
	"capabilities_json" jsonb DEFAULT '{}'::jsonb,
	"last_seen_at" timestamp with time zone,
	"namespace" text,
	"ingress_host" text,
	"mount_path" text DEFAULT '/workspace' NOT NULL,
	"primary_agent_id" text,
	"control_ui_enabled" boolean DEFAULT true NOT NULL,
	"dashboard_enabled" boolean DEFAULT false NOT NULL,
	"dashboard_state" text,
	"keep_alive_enabled" boolean DEFAULT false NOT NULL,
	"service_status" text DEFAULT 'unknown' NOT NULL,
	"service_status_at" timestamp with time zone,
	"sku_id" text,
	"cpu_millicores" integer,
	"memory_mb" integer,
	"disk_gb" integer,
	"region" text,
	"purchased_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"last_bootstrapped_at" timestamp with time zone,
	"framework_version" text,
	"framework_version_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"framework" text NOT NULL,
	"runtime" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sprite_status" text,
	"k8s_pod_phase" text,
	"account_id" text,
	"cluster_id" text,
	"daemon_id" text,
	"host_id" text,
	"runtime_id" text NOT NULL,
	"internal_id" text NOT NULL,
	"model" text,
	"model_provider_id" text,
	"extras" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"workspace_path" text,
	"sprite_name" text,
	"sprite_id" text,
	"mount_path" text DEFAULT '/workspace' NOT NULL,
	"storage_bytes" bigint,
	"storage_measured_at" timestamp with time zone,
	"storage_breakdown" jsonb,
	"file_roots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"namespace" text,
	"ingress_host" text,
	"current_phase" text,
	"failure_reason" text,
	"started_at" timestamp with time zone,
	"last_bootstrapped_at" timestamp with time zone,
	"last_reconciled_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"runtime_id" text NOT NULL,
	"framework" text NOT NULL,
	"payload_ciphertext" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_credentials_runtime_id_unique" UNIQUE("runtime_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"enforce_agent_binding" boolean DEFAULT false NOT NULL,
	"created_via" text,
	"token_kind" text DEFAULT 'user-grant' NOT NULL,
	"caller_agent_id" text,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "token_credentials" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_runtime_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"user_id" text NOT NULL,
	"runtime_kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"name" text NOT NULL,
	"token_ciphertext" text,
	"token_key_version" integer,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runtime_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_permissions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"user_id" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "permission_consent_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"requested_scopes" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"approved_scopes" jsonb,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cli_auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_code" text NOT NULL,
	"redirect_uri" text,
	"user_id" text,
	"auth_code_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"token_id" text,
	"requested_scopes" jsonb,
	"approved_scopes" jsonb,
	"requested_agent_id" text,
	"device_code_hash" text,
	"polled_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"exchanged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cli_auth_sessions_user_code_unique" UNIQUE("user_code"),
	CONSTRAINT "cli_auth_sessions_auth_code_hash_unique" UNIQUE("auth_code_hash"),
	CONSTRAINT "cli_auth_sessions_device_code_hash_unique" UNIQUE("device_code_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "a2a_connect_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_code" text NOT NULL,
	"device_code_hash" text NOT NULL,
	"client_name" text NOT NULL,
	"client_url" text,
	"user_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"approved_agent_ids" jsonb,
	"expires_in_days" integer,
	"polled_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"exchanged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "a2a_connect_sessions_user_code_unique" UNIQUE("user_code"),
	CONSTRAINT "a2a_connect_sessions_device_code_hash_unique" UNIQUE("device_code_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"subject" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"title" text,
	"framework_session_ref" text,
	"inflight_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_session_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"cutoff_message_id" text NOT NULL,
	"cutoff_created_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"role" text NOT NULL,
	"content_blocks_json" jsonb NOT NULL,
	"content_checkpoint_event_id" bigint,
	"capability_events_json" jsonb,
	"daemon_id" text,
	"daemon_exec_ref" text,
	"cancel_requested_at" timestamp with time zone,
	"abort_dispatched_at" timestamp with time zone,
	"compacted_stream_rows" bigint DEFAULT 0 NOT NULL,
	"stream_compacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_message_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"message_id" text,
	"source_kind" text NOT NULL,
	"framework" text NOT NULL,
	"runtime" text NOT NULL,
	"source_ref" text,
	"source_file" text,
	"source_seq" integer NOT NULL,
	"runner_seq" integer,
	"source_event_key" text NOT NULL,
	"external_id" text,
	"parent_external_id" text,
	"raw_format" text NOT NULL,
	"raw_text" text,
	"raw_json" jsonb,
	"raw_sha256" text NOT NULL,
	"raw_bytes" integer NOT NULL,
	"parser_name" text NOT NULL,
	"parser_version" text NOT NULL,
	"parsed_at" timestamp with time zone NOT NULL,
	"raw_cleared_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_stream_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"message_id" text NOT NULL,
	"seq" integer NOT NULL,
	"event_type" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"source_event_key" text,
	"source_event_ordinal" integer,
	"runner_seq" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "turn_executions" (
	"message_id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"runtime" text NOT NULL,
	"sprite_name" text,
	"exec_session_id" text,
	"upstream_task_id" text,
	"upstream_message_id" text,
	"owner_id" text NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"state" text NOT NULL,
	"adopt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "a2a_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"target_agent_id" text NOT NULL,
	"caller_agent_id" text,
	"external_subject" text,
	"context_id" text NOT NULL,
	"chat_session_id" text NOT NULL,
	"client_message_id" text NOT NULL,
	"user_message_id" text,
	"assistant_message_id" text,
	"state" text DEFAULT 'submitted' NOT NULL,
	"artifact_json" jsonb,
	"error_json" jsonb,
	"usage_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "a2a_agent_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"caller_agent_id" text NOT NULL,
	"target_agent_id" text NOT NULL,
	"user_id" text NOT NULL,
	"scopes" jsonb DEFAULT '["a2a:edit"]'::jsonb NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text,
	"runtime_id" text,
	"session_id" text,
	"message_id" text,
	"framework" text NOT NULL,
	"runtime_kind" text NOT NULL,
	"model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"cost_source" text NOT NULL,
	"is_fallback_model" boolean DEFAULT false NOT NULL,
	"first_token_ms" integer,
	"total_ms" integer,
	"model_provider_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_model_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"inference_protocol" text,
	"built_in_id" text,
	"external_account_id" text,
	"provider_name" text NOT NULL,
	"api_key_ciphertext" text NOT NULL,
	"base_url" text,
	"models_list_url" text,
	"key_version" integer DEFAULT 1 NOT NULL,
	"source" text DEFAULT 'byo' NOT NULL,
	"managed_service" text,
	"managed_key_id" text,
	"managed_brand" text,
	"last_tested_at" timestamp with time zone,
	"last_test_status" text,
	"last_test_message" text,
	"last_test_models" jsonb,
	"enabled_models" jsonb,
	"netmind_login_token_ciphertext" text,
	"netmind_login_token_key_version" integer,
	"netmind_login_token_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"display_name" text NOT NULL,
	"external_id" text,
	"secret_ciphertext" text,
	"key_version" integer DEFAULT 1 NOT NULL,
	"metadata" jsonb,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_external_agent_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"endpoint_url" text NOT NULL,
	"api_key_ciphertext" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_tested_at" timestamp with time zone,
	"last_test_status" text,
	"last_test_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_price_snapshots" (
	"source" text PRIMARY KEY NOT NULL,
	"etag" text,
	"entry_count" integer NOT NULL,
	"prices" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scoped_model_prices" (
	"id" text PRIMARY KEY NOT NULL,
	"built_in_id" text,
	"provider_id" text,
	"model_id" text NOT NULL,
	"input_cost_per_token" numeric(20, 12),
	"output_cost_per_token" numeric(20, 12),
	"cache_read_cost_per_token" numeric(20, 12),
	"cache_creation_cost_per_token" numeric(20, 12),
	"price_ref_source" text,
	"price_ref_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skill_repos" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"branch" text DEFAULT 'main' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"repo_branch" text NOT NULL,
	"source_path" text NOT NULL,
	"latest_revision" text,
	"readme_url" text,
	"category_id" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"missing_since" timestamp with time zone,
	"scanned_at" timestamp with time zone DEFAULT now(),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_skills" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"skill_id" text,
	"library_skill_id" text,
	"runtime_id" text,
	"agent_id" text,
	"framework" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"install_dir" text NOT NULL,
	"installed_revision" text,
	"installed_version" text,
	"materialize_status" text DEFAULT 'installing' NOT NULL,
	"materialize_error" text,
	"materialized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_skills_source_xor" CHECK ((skill_id IS NULL) <> (library_skill_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "library_skill_files" (
	"id" text PRIMARY KEY NOT NULL,
	"library_skill_id" text NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "library_skills" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"content" text NOT NULL,
	"origin" jsonb,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "library_skill_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"library_skill_id" text NOT NULL,
	"user_id" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"import_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_catalog_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"long_description" text,
	"icon_url" text,
	"homepage_url" text NOT NULL,
	"transport" text NOT NULL,
	"url" text,
	"headers" jsonb,
	"command" text,
	"args" jsonb,
	"env" jsonb,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"category_id" text,
	"featured" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_mcp_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"server_key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"transport" text NOT NULL,
	"url" text,
	"headers" jsonb,
	"command" text,
	"args" jsonb,
	"env" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "automation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"chat_session_id" text,
	"assistant_message_id" text,
	"error_message" text,
	"delivery_status" text,
	"title_snapshot" text NOT NULL,
	"prompt_snapshot" text NOT NULL,
	"rrule_snapshot" text NOT NULL,
	"model_snapshot" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "automations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"title" text NOT NULL,
	"prompt" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"schedule_preset" text NOT NULL,
	"rrule" text NOT NULL,
	"timezone" text NOT NULL,
	"dtstart" timestamp with time zone NOT NULL,
	"model" text,
	"delivery_channel_id" text,
	"delivery_target" jsonb,
	"origin" jsonb,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_backup_restores" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"backup_id" text NOT NULL,
	"target_agent_id" text,
	"status" text DEFAULT 'running' NOT NULL,
	"mode" text DEFAULT 'replace' NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_backups" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"source_agent_id" text,
	"source_agent_name" text NOT NULL,
	"framework" text NOT NULL,
	"runtime_kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"object_key" text NOT NULL,
	"archive_bytes" bigint DEFAULT 0 NOT NULL,
	"workspace_bytes" bigint DEFAULT 0 NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"sha256" text,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "channels" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"config_json" jsonb NOT NULL,
	"credentials_ciphertext" text,
	"key_version" integer DEFAULT 1 NOT NULL,
	"external_id" text,
	"origin" jsonb,
	"last_connected_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error_message" text,
	"reconnect_attempts" integer DEFAULT 0 NOT NULL,
	"next_reconnect_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lark_app_registrations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"label" text NOT NULL,
	"bot_name" text NOT NULL,
	"app_region" text NOT NULL,
	"poll_region" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"device_code_ciphertext" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"qr_url" text NOT NULL,
	"user_code" text NOT NULL,
	"interval_sec" integer DEFAULT 5 NOT NULL,
	"last_polled_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"channel_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "weixin_registrations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"qrcode_ciphertext" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"qrcode_content" text NOT NULL,
	"poll_base_url" text NOT NULL,
	"verify_code_ciphertext" text,
	"verify_key_version" integer,
	"refresh_count" integer DEFAULT 0 NOT NULL,
	"last_polled_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"channel_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "channel_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"chat_session_id" text NOT NULL,
	"scope_key" text NOT NULL,
	"scope_name" text,
	"remote_user_id" text,
	"remote_thread_id" text,
	"display_name" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"archived_at" timestamp with time zone,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "channel_deliveries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"chat_session_id" text,
	"chat_message_id" text,
	"direction" text NOT NULL,
	"scope_key" text NOT NULL,
	"provider_event_id" text,
	"provider_message_id" text,
	"event_json" jsonb,
	"summary_text" text,
	"status" text NOT NULL,
	"error_message" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"send_attempt_started_at" timestamp with time zone,
	"turn_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "channel_provider_states" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"state_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "channel_leases" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"holder_id" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_leases" (
	"name" text PRIMARY KEY NOT NULL,
	"holder_id" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "framework_model_catalog" (
	"id" text PRIMARY KEY NOT NULL,
	"framework" text NOT NULL,
	"model_key" text NOT NULL,
	"kind" text NOT NULL,
	"display_name" text NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "framework_enum_catalog" (
	"id" text PRIMARY KEY NOT NULL,
	"framework" text NOT NULL,
	"enum_key" text NOT NULL,
	"value" text NOT NULL,
	"display_name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sprite_quota_snapshots" (
	"at" timestamp with time zone PRIMARY KEY NOT NULL,
	"org_active" integer NOT NULL,
	"org_warm" integer NOT NULL,
	"org_cold" integer NOT NULL,
	"org_provisioned" integer NOT NULL,
	"org_storage_bytes" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sandbox_active_duration_days" (
	"host_id" text NOT NULL,
	"user_id" text NOT NULL,
	"day" text NOT NULL,
	"active_seconds" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_active_duration_days_host_id_day_pk" PRIMARY KEY("host_id","day"),
	CONSTRAINT "sandbox_active_duration_days_day_shape" CHECK ("sandbox_active_duration_days"."day" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_api_usage_days" (
	"user_id" text NOT NULL,
	"day" text NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_api_usage_days_user_id_day_pk" PRIMARY KEY("user_id","day"),
	CONSTRAINT "user_api_usage_days_day_shape" CHECK ("user_api_usage_days"."day" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"events" jsonb NOT NULL,
	"config_ciphertext" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"last_delivery_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_passwords" ADD CONSTRAINT "user_passwords_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_avatars" ADD CONSTRAINT "user_avatars_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "runtime_hosts" ADD CONSTRAINT "runtime_hosts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "runtime_hosts" ADD CONSTRAINT "runtime_hosts_account_id_sprites_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."sprites_accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daemon_tokens" ADD CONSTRAINT "daemon_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daemon_tokens" ADD CONSTRAINT "daemon_tokens_daemon_id_runtime_hosts_id_fk" FOREIGN KEY ("daemon_id") REFERENCES "public"."runtime_hosts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runtimes" ADD CONSTRAINT "agent_runtimes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runtimes" ADD CONSTRAINT "agent_runtimes_account_id_sprites_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."sprites_accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runtimes" ADD CONSTRAINT "agent_runtimes_cluster_id_k8s_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."k8s_clusters"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runtimes" ADD CONSTRAINT "agent_runtimes_daemon_id_runtime_hosts_id_fk" FOREIGN KEY ("daemon_id") REFERENCES "public"."runtime_hosts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runtimes" ADD CONSTRAINT "agent_runtimes_host_id_runtime_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."runtime_hosts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents" ADD CONSTRAINT "agents_account_id_sprites_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."sprites_accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents" ADD CONSTRAINT "agents_cluster_id_k8s_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."k8s_clusters"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents" ADD CONSTRAINT "agents_daemon_id_runtime_hosts_id_fk" FOREIGN KEY ("daemon_id") REFERENCES "public"."runtime_hosts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents" ADD CONSTRAINT "agents_host_id_runtime_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."runtime_hosts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents" ADD CONSTRAINT "agents_runtime_id_agent_runtimes_id_fk" FOREIGN KEY ("runtime_id") REFERENCES "public"."agent_runtimes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents" ADD CONSTRAINT "agents_model_provider_id_fkey" FOREIGN KEY ("model_provider_id") REFERENCES "public"."user_model_providers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_runtime_id_agent_runtimes_id_fk" FOREIGN KEY ("runtime_id") REFERENCES "public"."agent_runtimes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_token_hash_token_credentials_token_hash_fk" FOREIGN KEY ("token_hash") REFERENCES "public"."token_credentials"("token_hash") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_caller_agent_id_agents_id_fk" FOREIGN KEY ("caller_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runtime_tokens" ADD CONSTRAINT "agent_runtime_tokens_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runtime_tokens" ADD CONSTRAINT "agent_runtime_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runtime_tokens" ADD CONSTRAINT "agent_runtime_tokens_token_hash_token_credentials_token_hash_fk" FOREIGN KEY ("token_hash") REFERENCES "public"."token_credentials"("token_hash") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_permissions" ADD CONSTRAINT "agent_permissions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_permissions" ADD CONSTRAINT "agent_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "permission_consent_requests" ADD CONSTRAINT "permission_consent_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "permission_consent_requests" ADD CONSTRAINT "permission_consent_requests_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cli_auth_sessions" ADD CONSTRAINT "cli_auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cli_auth_sessions" ADD CONSTRAINT "cli_auth_sessions_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."api_tokens"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cli_auth_sessions" ADD CONSTRAINT "cli_auth_sessions_requested_agent_id_agents_id_fk" FOREIGN KEY ("requested_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "a2a_connect_sessions" ADD CONSTRAINT "a2a_connect_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_session_shares" ADD CONSTRAINT "chat_session_shares_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_session_shares" ADD CONSTRAINT "chat_session_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_message_sources" ADD CONSTRAINT "chat_message_sources_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_message_sources" ADD CONSTRAINT "chat_message_sources_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_stream_events" ADD CONSTRAINT "chat_stream_events_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_stream_events" ADD CONSTRAINT "chat_stream_events_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "turn_executions" ADD CONSTRAINT "turn_executions_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "turn_executions" ADD CONSTRAINT "turn_executions_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "a2a_tasks" ADD CONSTRAINT "a2a_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "a2a_tasks" ADD CONSTRAINT "a2a_tasks_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "a2a_tasks" ADD CONSTRAINT "a2a_tasks_caller_agent_id_agents_id_fk" FOREIGN KEY ("caller_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "a2a_tasks" ADD CONSTRAINT "a2a_tasks_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "a2a_tasks" ADD CONSTRAINT "a2a_tasks_user_message_id_chat_messages_id_fk" FOREIGN KEY ("user_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "a2a_tasks" ADD CONSTRAINT "a2a_tasks_assistant_message_id_chat_messages_id_fk" FOREIGN KEY ("assistant_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "a2a_agent_grants" ADD CONSTRAINT "a2a_agent_grants_caller_agent_id_agents_id_fk" FOREIGN KEY ("caller_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "a2a_agent_grants" ADD CONSTRAINT "a2a_agent_grants_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "a2a_agent_grants" ADD CONSTRAINT "a2a_agent_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_usage_events" ADD CONSTRAINT "agent_usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_usage_events" ADD CONSTRAINT "agent_usage_events_model_provider_id_fkey" FOREIGN KEY ("model_provider_id") REFERENCES "public"."user_model_providers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_model_providers" ADD CONSTRAINT "user_model_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_connections" ADD CONSTRAINT "user_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_external_agent_providers" ADD CONSTRAINT "user_external_agent_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scoped_model_prices" ADD CONSTRAINT "scoped_model_prices_provider_id_user_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."user_model_providers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "skill_repos" ADD CONSTRAINT "skill_repos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "skills" ADD CONSTRAINT "skills_category_id_catalog_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."catalog_categories"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_skills" ADD CONSTRAINT "user_skills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_skills" ADD CONSTRAINT "user_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_skills" ADD CONSTRAINT "user_skills_library_skill_id_library_skills_id_fk" FOREIGN KEY ("library_skill_id") REFERENCES "public"."library_skills"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_skills" ADD CONSTRAINT "user_skills_runtime_id_agent_runtimes_id_fk" FOREIGN KEY ("runtime_id") REFERENCES "public"."agent_runtimes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_skills" ADD CONSTRAINT "user_skills_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "library_skill_files" ADD CONSTRAINT "library_skill_files_library_skill_id_library_skills_id_fk" FOREIGN KEY ("library_skill_id") REFERENCES "public"."library_skills"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "library_skills" ADD CONSTRAINT "library_skills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "library_skill_shares" ADD CONSTRAINT "library_skill_shares_library_skill_id_library_skills_id_fk" FOREIGN KEY ("library_skill_id") REFERENCES "public"."library_skills"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "library_skill_shares" ADD CONSTRAINT "library_skill_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_catalog_entries" ADD CONSTRAINT "mcp_catalog_entries_category_id_catalog_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."catalog_categories"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_mcp_servers" ADD CONSTRAINT "user_mcp_servers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_assistant_message_id_chat_messages_id_fk" FOREIGN KEY ("assistant_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "automations" ADD CONSTRAINT "automations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "automations" ADD CONSTRAINT "automations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "automations" ADD CONSTRAINT "automations_delivery_channel_id_channels_id_fk" FOREIGN KEY ("delivery_channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_backup_restores" ADD CONSTRAINT "agent_backup_restores_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_backup_restores" ADD CONSTRAINT "agent_backup_restores_backup_id_agent_backups_id_fk" FOREIGN KEY ("backup_id") REFERENCES "public"."agent_backups"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_backup_restores" ADD CONSTRAINT "agent_backup_restores_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_backups" ADD CONSTRAINT "agent_backups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_backups" ADD CONSTRAINT "agent_backups_source_agent_id_agents_id_fk" FOREIGN KEY ("source_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channels" ADD CONSTRAINT "channels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channels" ADD CONSTRAINT "channels_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lark_app_registrations" ADD CONSTRAINT "lark_app_registrations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lark_app_registrations" ADD CONSTRAINT "lark_app_registrations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lark_app_registrations" ADD CONSTRAINT "lark_app_registrations_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "weixin_registrations" ADD CONSTRAINT "weixin_registrations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "weixin_registrations" ADD CONSTRAINT "weixin_registrations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "weixin_registrations" ADD CONSTRAINT "weixin_registrations_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_sessions" ADD CONSTRAINT "channel_sessions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_sessions" ADD CONSTRAINT "channel_sessions_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_deliveries" ADD CONSTRAINT "channel_deliveries_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_deliveries" ADD CONSTRAINT "channel_deliveries_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_deliveries" ADD CONSTRAINT "channel_deliveries_chat_message_id_chat_messages_id_fk" FOREIGN KEY ("chat_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_provider_states" ADD CONSTRAINT "channel_provider_states_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_leases" ADD CONSTRAINT "channel_leases_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sandbox_active_duration_days" ADD CONSTRAINT "sandbox_active_duration_days_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_api_usage_days" ADD CONSTRAINT "user_api_usage_days_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_identities_user_idx" ON "auth_identities" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "auth_identities_one_email_per_user" ON "auth_identities" USING btree ("user_id") WHERE "auth_identities"."provider" = 'email';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_sessions_user_id_idx" ON "user_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_sessions_active_idx" ON "user_sessions" USING btree ("revoked_at","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_verifications_email_purpose_idx" ON "email_verifications" USING btree ("email","purpose");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_verifications_expires_idx" ON "email_verifications" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_states_expires_idx" ON "oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_hosts_user_uuid_unique" ON "runtime_hosts" USING btree ("user_id","daemon_uuid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "daemon_tokens_daemon_id_idx" ON "daemon_tokens" USING btree ("daemon_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "daemon_tokens_user_id_idx" ON "daemon_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runtimes_user_name_idx" ON "agent_runtimes" USING btree ("user_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_runtimes_sprite_host_framework_uq" ON "agent_runtimes" USING btree ("host_id","framework") WHERE "agent_runtimes"."kind" = 'sprites' and "agent_runtimes"."status" not in ('failed', 'stopped');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runtimes_daemon_id_idx" ON "agent_runtimes" USING btree ("daemon_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_runtime_internal_unique" ON "agents" USING btree ("runtime_id","internal_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_model_provider_idx" ON "agents" USING btree ("model_provider_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_daemon_id_idx" ON "agents" USING btree ("daemon_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_host_id_idx" ON "agents" USING btree ("host_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_tokens_agent_id_idx" ON "api_tokens" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_tokens_caller_agent_id_idx" ON "api_tokens" USING btree ("caller_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_tokens_created_via_idx" ON "api_tokens" USING btree ("created_via");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_tokens_agent_id_active_uq" ON "api_tokens" USING btree ("agent_id") WHERE "api_tokens"."revoked_at" is null and "api_tokens"."agent_id" is not null and "api_tokens"."token_kind" = 'user-grant';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_tokens_a2a_grant_uq" ON "api_tokens" USING btree ("agent_id","caller_agent_id") WHERE "api_tokens"."token_kind" = 'a2a-grant' and "api_tokens"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runtime_tokens_agent_id_idx" ON "agent_runtime_tokens" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_runtime_tokens_agent_kind_active_uq" ON "agent_runtime_tokens" USING btree ("agent_id","runtime_kind") WHERE "agent_runtime_tokens"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_permissions_agent_id_uq" ON "agent_permissions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "permission_consent_requests_agent_created_idx" ON "permission_consent_requests" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cli_auth_sessions_status_expires_idx" ON "cli_auth_sessions" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "a2a_connect_sessions_status_expires_idx" ON "a2a_connect_sessions" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_sessions_user_agent_idx" ON "chat_sessions" USING btree ("user_id","agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_sessions_updated_at_id_idx" ON "chat_sessions" USING btree ("updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_session_shares_active_session_uq" ON "chat_session_shares" USING btree ("session_id") WHERE "chat_session_shares"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_session_created_idx" ON "chat_messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_daemon_exec_ref_idx" ON "chat_messages" USING btree ("daemon_id","daemon_exec_ref") WHERE "chat_messages"."daemon_exec_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_message_sources_event_key_unique" ON "chat_message_sources" USING btree ("source_event_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_message_sources_session_idx" ON "chat_message_sources" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_message_sources_message_idx" ON "chat_message_sources" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_message_sources_raw_cleared_idx" ON "chat_message_sources" USING btree ("raw_cleared_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_message_sources_raw_pending_idx" ON "chat_message_sources" USING btree ("created_at","id") WHERE "chat_message_sources"."raw_cleared_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_stream_events_message_seq_unique" ON "chat_stream_events" USING btree ("message_id","seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_stream_events_session_id_id_idx" ON "chat_stream_events" USING btree ("session_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_stream_events_message_id_id_idx" ON "chat_stream_events" USING btree ("message_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_stream_events_source_dedup_unique" ON "chat_stream_events" USING btree ("message_id","source_event_key","source_event_ordinal") WHERE "chat_stream_events"."source_event_key" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_stream_events_message_terminal_idx" ON "chat_stream_events" USING btree ("message_id") WHERE "chat_stream_events"."event_type" in ('done', 'error');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "turn_executions_adoptable_idx" ON "turn_executions" USING btree ("lease_expires_at") WHERE "turn_executions"."state" in ('running', 'handoff', 'adopting');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "turn_executions_session_idx" ON "turn_executions" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "a2a_tasks_target_created_idx" ON "a2a_tasks" USING btree ("target_agent_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "a2a_tasks_context_idx" ON "a2a_tasks" USING btree ("context_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "a2a_tasks_caller_idx" ON "a2a_tasks" USING btree ("caller_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "a2a_tasks_session_client_message_uq" ON "a2a_tasks" USING btree ("chat_session_id","client_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "a2a_agent_grants_caller_target_active_uq" ON "a2a_agent_grants" USING btree ("caller_agent_id","target_agent_id") WHERE "a2a_agent_grants"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "a2a_agent_grants_caller_target_idx" ON "a2a_agent_grants" USING btree ("caller_agent_id","target_agent_id","revoked_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_usage_events_user_created_idx" ON "agent_usage_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_usage_events_runtime_created_idx" ON "agent_usage_events" USING btree ("runtime_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_usage_events_agent_created_idx" ON "agent_usage_events" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_usage_events_session_idx" ON "agent_usage_events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_usage_events_model_provider_idx" ON "agent_usage_events" USING btree ("model_provider_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_usage_events_message_unique" ON "agent_usage_events" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_model_providers_user_idx" ON "user_model_providers" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_model_providers_custom_name_unique" ON "user_model_providers" USING btree ("user_id","provider_name") WHERE "user_model_providers"."built_in_id" is null and "user_model_providers"."source" = 'byo';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_model_providers_byo_external_account_unique" ON "user_model_providers" USING btree ("user_id","built_in_id","external_account_id") WHERE "user_model_providers"."external_account_id" is not null and "user_model_providers"."source" = 'byo';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_model_providers_managed_brand_unique" ON "user_model_providers" USING btree ("user_id","managed_service","managed_brand") WHERE "user_model_providers"."source" = 'managed';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_model_providers_managed_key_idx" ON "user_model_providers" USING btree ("managed_service","managed_key_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_connections_user_idx" ON "user_connections" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_connections_active_external_unique" ON "user_connections" USING btree ("user_id","provider","external_id") WHERE "user_connections"."external_id" is not null and "user_connections"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_external_agent_providers_user_idx" ON "user_external_agent_providers" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_external_agent_providers_user_provider_label_unique" ON "user_external_agent_providers" USING btree ("user_id","provider","label");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scoped_model_prices_built_in_model_unique" ON "scoped_model_prices" USING btree ("built_in_id","model_id") WHERE "scoped_model_prices"."built_in_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scoped_model_prices_provider_model_unique" ON "scoped_model_prices" USING btree ("provider_id","model_id") WHERE "scoped_model_prices"."provider_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scoped_model_prices_provider_idx" ON "scoped_model_prices" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_repos_user_idx" ON "skill_repos" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skill_repos_user_repo_unique" ON "skill_repos" USING btree ("user_id","owner","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skills_repo_path_unique" ON "skills" USING btree ("repo_owner","repo_name","repo_branch","source_path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_skills_lookup_idx" ON "user_skills" USING btree ("user_id","agent_id","enabled");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_skills_runtime_lookup_idx" ON "user_skills" USING btree ("user_id","runtime_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_skills_user_skill_unique" ON "user_skills" USING btree ("user_id","agent_id","skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_skills_user_library_skill_unique" ON "user_skills" USING btree ("user_id","agent_id","library_skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_skills_user_install_dir_unique" ON "user_skills" USING btree ("user_id","agent_id","install_dir");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "library_skill_files_skill_path_unique" ON "library_skill_files" USING btree ("library_skill_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "library_skills_user_name_unique" ON "library_skills" USING btree ("user_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "library_skill_shares_active_skill_uq" ON "library_skill_shares" USING btree ("library_skill_id") WHERE "library_skill_shares"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_categories_domain_name_unique" ON "catalog_categories" USING btree ("domain","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_catalog_entries_slug_unique" ON "mcp_catalog_entries" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_mcp_servers_user_server_key_unique" ON "user_mcp_servers" USING btree ("user_id","server_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_runs_automation_started_idx" ON "automation_runs" USING btree ("automation_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_runs_status_idx" ON "automation_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_runs_message_idx" ON "automation_runs" USING btree ("assistant_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automations_user_updated_idx" ON "automations" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automations_agent_idx" ON "automations" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automations_due_idx" ON "automations" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automations_deleted_at_idx" ON "automations" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_backup_restores_user_created_idx" ON "agent_backup_restores" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_backup_restores_backup_idx" ON "agent_backup_restores" USING btree ("backup_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_backup_restores_target_agent_idx" ON "agent_backup_restores" USING btree ("target_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_backups_user_created_idx" ON "agent_backups" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_backups_source_agent_idx" ON "agent_backups" USING btree ("source_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_backups_status_idx" ON "agent_backups" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channels_user_updated_idx" ON "channels" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channels_agent_idx" ON "channels" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channels_status_idx" ON "channels" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "channels_provider_external_idx" ON "channels" USING btree ("provider","external_id") WHERE "channels"."external_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lark_app_registrations_user_status_idx" ON "lark_app_registrations" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lark_app_registrations_status_expires_idx" ON "lark_app_registrations" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "weixin_registrations_user_status_idx" ON "weixin_registrations" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "weixin_registrations_status_expires_idx" ON "weixin_registrations" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "channel_sessions_active_unique" ON "channel_sessions" USING btree ("channel_id","scope_key") WHERE "channel_sessions"."is_active" = true AND "channel_sessions"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_sessions_scope_history_idx" ON "channel_sessions" USING btree ("channel_id","scope_key","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_sessions_chat_session_idx" ON "channel_sessions" USING btree ("chat_session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_deliveries_channel_created_idx" ON "channel_deliveries" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_deliveries_session_idx" ON "channel_deliveries" USING btree ("chat_session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_deliveries_status_idx" ON "channel_deliveries" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_deliveries_recovery_idx" ON "channel_deliveries" USING btree ("direction","status","next_attempt_at") WHERE "channel_deliveries"."status" in ('queued', 'failed', 'processing');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "channel_deliveries_inbound_event_unique" ON "channel_deliveries" USING btree ("channel_id","provider_event_id") WHERE "channel_deliveries"."direction" = 'inbound' and "channel_deliveries"."provider_event_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "framework_model_catalog_framework_key_unique" ON "framework_model_catalog" USING btree ("framework","model_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "framework_model_catalog_default_unique" ON "framework_model_catalog" USING btree ("framework","kind") WHERE "framework_model_catalog"."is_default" = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "framework_model_catalog_active_idx" ON "framework_model_catalog" USING btree ("framework","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "framework_enum_catalog_framework_key_value_unique" ON "framework_enum_catalog" USING btree ("framework","enum_key","value");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "framework_enum_catalog_default_unique" ON "framework_enum_catalog" USING btree ("framework","enum_key") WHERE "framework_enum_catalog"."is_default" = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "framework_enum_catalog_active_idx" ON "framework_enum_catalog" USING btree ("framework","enum_key","is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sandbox_active_duration_days_user_day_idx" ON "sandbox_active_duration_days" USING btree ("user_id","day");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_webhooks_enabled_idx" ON "notification_webhooks" USING btree ("enabled");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mf_agent_runtime_tokens_credential_check()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
	IF EXISTS (SELECT 1 FROM api_tokens WHERE token_hash = NEW.token_hash) THEN
		RAISE EXCEPTION 'token_hash already registered as an external credential' USING ERRCODE = '23505';
	END IF;
	IF (SELECT kind FROM token_credentials WHERE token_hash = NEW.token_hash) IS DISTINCT FROM 'runtime' THEN
		RAISE EXCEPTION 'token_hash is not a runtime credential' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mf_api_tokens_credential_sync()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
	IF EXISTS (SELECT 1 FROM agent_runtime_tokens WHERE token_hash = NEW.token_hash) THEN
		RAISE EXCEPTION 'token_hash already registered as a runtime credential' USING ERRCODE = '23505';
	END IF;
	INSERT INTO token_credentials (token_hash, kind, created_at)
	VALUES (NEW.token_hash, 'external', NEW.created_at)
	ON CONFLICT (token_hash) DO NOTHING;
	IF (SELECT kind FROM token_credentials WHERE token_hash = NEW.token_hash) <> 'external' THEN
		RAISE EXCEPTION 'token_hash is not an external credential' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mf_object_id(prefix text)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE
	alphabet constant text := 'abcdefghijklmnopqrstuvwxyz234567';
	bytes bytea := uuid_send(gen_random_uuid());
	acc bigint := 0;
	nbits int := 0;
	i int;
	idx int;
	chars text := '';
BEGIN
	FOR i IN 0..15 LOOP
		acc := (acc << 8) | get_byte(bytes, i);
		nbits := nbits + 8;
		WHILE nbits >= 5 LOOP
			nbits := nbits - 5;
			idx := (acc >> nbits) & 31;
			chars := chars || substr(alphabet, idx + 1, 1);
		END LOOP;
		acc := acc & ((1 << nbits) - 1);
	END LOOP;
	IF nbits > 0 THEN
		idx := (acc << (5 - nbits)) & 31;
		chars := chars || substr(alphabet, idx + 1, 1);
	END IF;
	RETURN prefix || '_' || chars;
END;
$function$
;
--> statement-breakpoint
CREATE TRIGGER mf_agent_runtime_tokens_credential_check BEFORE INSERT OR UPDATE OF token_hash ON public.agent_runtime_tokens FOR EACH ROW EXECUTE FUNCTION mf_agent_runtime_tokens_credential_check();
--> statement-breakpoint
CREATE TRIGGER mf_api_tokens_credential_sync BEFORE INSERT OR UPDATE OF token_hash ON public.api_tokens FOR EACH ROW EXECUTE FUNCTION mf_api_tokens_credential_sync();
--> statement-breakpoint
INSERT INTO public.app_settings (key, value_json, created_at, updated_at) VALUES ('builtin_skill_repos', '{"repos": [{"name": "skills", "owner": "anthropics", "branch": "main", "enabled": true}, {"name": "awesome-claude-skills", "owner": "ComposioHQ", "branch": "master", "enabled": true}, {"name": "myclaude", "owner": "cexll", "branch": "master", "enabled": true}, {"name": "baoyu-skills", "owner": "JimLiu", "branch": "main", "enabled": true}, {"name": "hermes-agent", "owner": "NousResearch", "branch": "main", "enabled": true}]}'::jsonb, '2026-08-18 11:36:09.479641+00'::timestamptz, '2026-08-18 11:36:09.479641+00'::timestamptz);
--> statement-breakpoint
INSERT INTO public.app_settings (key, value_json, created_at, updated_at) VALUES ('framework_runtime_defaults', '{"defaults": {"hermes": "sprites", "openclaw": "sprites"}}'::jsonb, '2026-08-18 11:36:09.479641+00'::timestamptz, '2026-08-18 11:36:09.479641+00'::timestamptz);
--> statement-breakpoint
INSERT INTO public.framework_enum_catalog (id, framework, enum_key, value, display_name, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fec_seed_codex_speed_standard', 'codex', 'speed', 'standard', 'Standard', 10, true, true, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_enum_catalog (id, framework, enum_key, value, display_name, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fec_seed_codex_speed_fast', 'codex', 'speed', 'fast', 'Fast', 20, true, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_enum_catalog (id, framework, enum_key, value, display_name, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fec_seed_codex_intel_low', 'codex', 'intelligence', 'low', 'Low', 20, true, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_enum_catalog (id, framework, enum_key, value, display_name, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fec_seed_codex_intel_medium', 'codex', 'intelligence', 'medium', 'Medium', 30, true, true, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_enum_catalog (id, framework, enum_key, value, display_name, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fec_seed_codex_intel_high', 'codex', 'intelligence', 'high', 'High', 40, true, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_enum_catalog (id, framework, enum_key, value, display_name, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fec_seed_codex_intel_xhigh', 'codex', 'intelligence', 'xhigh', 'Extra High', 50, true, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_enum_catalog (id, framework, enum_key, value, display_name, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fec_seed_cc_effort_low', 'claude-code', 'effort', 'low', 'Low', 10, true, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_enum_catalog (id, framework, enum_key, value, display_name, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fec_seed_cc_effort_high', 'claude-code', 'effort', 'high', 'High', 30, true, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_enum_catalog (id, framework, enum_key, value, display_name, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fec_seed_cc_effort_max', 'claude-code', 'effort', 'max', 'Max', 50, true, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_enum_catalog (id, framework, enum_key, value, display_name, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fec_seed_cc_effort_xhigh', 'claude-code', 'effort', 'xhigh', 'Extra High', 40, true, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_enum_catalog (id, framework, enum_key, value, display_name, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fec_seed_cc_effort_medium', 'claude-code', 'effort', 'medium', 'Medium', 20, true, true, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_enum_catalog (id, framework, enum_key, value, display_name, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fec_seed_codex_intel_none', 'codex', 'intelligence', 'none', 'None', 10, false, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
--> statement-breakpoint
INSERT INTO public.framework_model_catalog (id, framework, model_key, kind, display_name, capabilities, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fmc_seed_codex_gpt55', 'codex', 'gpt-5.5', 'model', 'GPT-5.5', '{"fast": true}', 10, true, true, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_model_catalog (id, framework, model_key, kind, display_name, capabilities, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fmc_seed_codex_gpt54', 'codex', 'gpt-5.4', 'model', 'GPT-5.4', '{"fast": true}', 20, true, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_model_catalog (id, framework, model_key, kind, display_name, capabilities, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fmc_seed_codex_gpt54mini', 'codex', 'gpt-5.4-mini', 'model', 'GPT-5.4 Mini', '{}', 30, true, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_model_catalog (id, framework, model_key, kind, display_name, capabilities, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fmc_seed_codex_gpt53codex', 'codex', 'gpt-5.3-codex', 'model', 'GPT-5.3 Codex', '{}', 40, true, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_model_catalog (id, framework, model_key, kind, display_name, capabilities, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fmc_seed_codex_gpt52', 'codex', 'gpt-5.2', 'model', 'GPT-5.2', '{}', 50, true, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_model_catalog (id, framework, model_key, kind, display_name, capabilities, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fmc_seed_cc_opus', 'claude-code', 'opus', 'alias', 'Opus', '{}', 10, true, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_model_catalog (id, framework, model_key, kind, display_name, capabilities, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fmc_seed_cc_opus1m', 'claude-code', 'opus[1m]', 'alias', 'Opus (1M context)', '{"longContext": true}', 20, true, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_model_catalog (id, framework, model_key, kind, display_name, capabilities, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fmc_seed_cc_sonnet', 'claude-code', 'sonnet', 'alias', 'Sonnet', '{}', 30, true, true, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_model_catalog (id, framework, model_key, kind, display_name, capabilities, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fmc_seed_cc_sonnet1m', 'claude-code', 'sonnet[1m]', 'alias', 'Sonnet (1M context)', '{"longContext": true}', 40, true, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_model_catalog (id, framework, model_key, kind, display_name, capabilities, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fmc_seed_cc_haiku', 'claude-code', 'haiku', 'alias', 'Haiku', '{}', 50, true, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_model_catalog (id, framework, model_key, kind, display_name, capabilities, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fmc_seed_gemini_20flash', 'gemini-cli', 'gemini-2.0-flash', 'model', 'Gemini 2.0 Flash', '{}', 30, false, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_model_catalog (id, framework, model_key, kind, display_name, capabilities, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fmc_seed_gemini_25pro', 'gemini-cli', 'gemini-2.5-pro', 'model', 'Gemini 2.5 Pro', '{}', 40, true, true, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_model_catalog (id, framework, model_key, kind, display_name, capabilities, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fmc_seed_gemini_25flash', 'gemini-cli', 'gemini-2.5-flash', 'model', 'Gemini 2.5 Flash', '{}', 50, true, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_model_catalog (id, framework, model_key, kind, display_name, capabilities, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fmc_seed_gemini_31propre', 'gemini-cli', 'gemini-3.1-pro-preview', 'model', 'Gemini 3.1 Pro (preview)', '{"longContext": true}', 10, true, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_model_catalog (id, framework, model_key, kind, display_name, capabilities, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fmc_seed_gemini_3flashpre', 'gemini-cli', 'gemini-3-flash-preview', 'model', 'Gemini 3 Flash (preview)', '{}', 20, true, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_model_catalog (id, framework, model_key, kind, display_name, capabilities, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fmc_seed_gemini_25flashlite', 'gemini-cli', 'gemini-2.5-flash-lite', 'model', 'Gemini 2.5 Flash Lite', '{}', 60, true, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_model_catalog (id, framework, model_key, kind, display_name, capabilities, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fmc_seed_cc_fable', 'claude-code', 'fable', 'alias', 'Fable', '{}', 5, true, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_model_catalog (id, framework, model_key, kind, display_name, capabilities, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fmc_seed_cc_best', 'claude-code', 'best', 'alias', 'Best available', '{}', 2, false, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_model_catalog (id, framework, model_key, kind, display_name, capabilities, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fmc_seed_cc_opusplan', 'claude-code', 'opusplan', 'alias', 'Opus Plan', '{}', 25, false, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_model_catalog (id, framework, model_key, kind, display_name, capabilities, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fmc_seed_codex_gpt56sol', 'codex', 'gpt-5.6-sol', 'model', 'GPT-5.6 Sol', '{"fast": true}', 1, true, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_model_catalog (id, framework, model_key, kind, display_name, capabilities, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fmc_seed_codex_gpt56terra', 'codex', 'gpt-5.6-terra', 'model', 'GPT-5.6 Terra', '{"fast": true}', 2, true, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_model_catalog (id, framework, model_key, kind, display_name, capabilities, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fmc_seed_codex_gpt56luna', 'codex', 'gpt-5.6-luna', 'model', 'GPT-5.6 Luna', '{"fast": true}', 3, true, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_model_catalog (id, framework, model_key, kind, display_name, capabilities, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fmc_seed_codex_gpt53spark', 'codex', 'gpt-5.3-codex-spark', 'model', 'GPT-5.3 Codex Spark', '{}', 90, false, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_model_catalog (id, framework, model_key, kind, display_name, capabilities, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fmc_seed_gemini_auto', 'gemini-cli', 'auto', 'alias', 'Auto (recommended)', '{}', 1, true, true, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_model_catalog (id, framework, model_key, kind, display_name, capabilities, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fmc_seed_gemini_35flash', 'gemini-cli', 'gemini-3.5-flash', 'model', 'Gemini 3.5 Flash', '{}', 5, true, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_model_catalog (id, framework, model_key, kind, display_name, capabilities, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fmc_seed_gemini_31flashlite', 'gemini-cli', 'gemini-3.1-flash-lite', 'model', 'Gemini 3.1 Flash Lite', '{}', 25, true, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.framework_model_catalog (id, framework, model_key, kind, display_name, capabilities, sort_order, is_active, is_default, created_at, updated_at) VALUES ('fmc_seed_gemini_31flashlitepre', 'gemini-cli', 'gemini-3.1-flash-lite-preview', 'model', 'Gemini 3.1 Flash Lite (preview)', '{}', 30, false, false, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
--> statement-breakpoint
INSERT INTO public.mcp_catalog_entries (id, slug, name, description, long_description, icon_url, homepage_url, transport, url, headers, command, args, env, tags, category_id, featured, sort_order, is_active, created_at, updated_at) VALUES ('mcp_agptofrydb3bndpkb4holikyuu', 'context7', 'Context7', 'Up-to-date, version-specific documentation and code examples for any library, pulled straight into the agent context. API key optional (raises rate limits).', NULL, NULL, 'https://context7.com', 'http', 'https://mcp.context7.com/mcp', '{"CONTEXT7_API_KEY": "${CONTEXT7_API_KEY}"}', NULL, NULL, NULL, '["docs", "libraries"]', NULL, false, 0, true, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.mcp_catalog_entries (id, slug, name, description, long_description, icon_url, homepage_url, transport, url, headers, command, args, env, tags, category_id, featured, sort_order, is_active, created_at, updated_at) VALUES ('mcp_agptofrydb6bffy7y32rdkh63a', 'deepwiki', 'DeepWiki', 'Ask questions about any public GitHub repository and read AI-generated wiki docs. No authentication required.', NULL, NULL, 'https://deepwiki.com', 'http', 'https://mcp.deepwiki.com/mcp', NULL, NULL, NULL, NULL, '["github", "docs", "research"]', NULL, false, 1, true, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.mcp_catalog_entries (id, slug, name, description, long_description, icon_url, homepage_url, transport, url, headers, command, args, env, tags, category_id, featured, sort_order, is_active, created_at, updated_at) VALUES ('mcp_agptofrydb5yhnaap7fbrogxfu', 'github', 'GitHub', 'Official GitHub MCP server: repositories, issues, pull requests, actions and code search. Requires a GitHub personal access token.', NULL, NULL, 'https://github.com/github/github-mcp-server', 'http', 'https://api.githubcopilot.com/mcp/', '{"Authorization": "Bearer ${GITHUB_PAT}"}', NULL, NULL, NULL, '["git", "issues", "pull-requests"]', NULL, false, 2, true, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.mcp_catalog_entries (id, slug, name, description, long_description, icon_url, homepage_url, transport, url, headers, command, args, env, tags, category_id, featured, sort_order, is_active, created_at, updated_at) VALUES ('mcp_agptofrydby4fp6jtlblewuhw4', 'playwright', 'Playwright', 'Browser automation via Playwright: navigate pages, interact with the DOM through accessibility snapshots and run end-to-end checks.', NULL, NULL, 'https://github.com/microsoft/playwright-mcp', 'stdio', NULL, NULL, 'npx', '["@playwright/mcp@latest"]', NULL, '["browser", "testing", "automation"]', NULL, false, 3, true, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.mcp_catalog_entries (id, slug, name, description, long_description, icon_url, homepage_url, transport, url, headers, command, args, env, tags, category_id, featured, sort_order, is_active, created_at, updated_at) VALUES ('mcp_agptofrydbyfpem3jpmsq3veqy', 'chrome-devtools', 'Chrome DevTools', 'Control and inspect a live Chrome browser: debug pages, read console and network activity, and analyze performance traces.', NULL, NULL, 'https://github.com/ChromeDevTools/chrome-devtools-mcp', 'stdio', NULL, NULL, 'npx', '["chrome-devtools-mcp@latest"]', NULL, '["browser", "debugging", "performance"]', NULL, false, 4, true, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.mcp_catalog_entries (id, slug, name, description, long_description, icon_url, homepage_url, transport, url, headers, command, args, env, tags, category_id, featured, sort_order, is_active, created_at, updated_at) VALUES ('mcp_agptofrydbzn5lwa5tgm34vlzu', 'sentry', 'Sentry', 'Query Sentry issues, errors and performance data from your projects. Authenticates via OAuth on first use.', NULL, NULL, 'https://docs.sentry.io/product/sentry-mcp/', 'http', 'https://mcp.sentry.dev/mcp', NULL, NULL, NULL, NULL, '["errors", "monitoring"]', NULL, false, 5, true, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.mcp_catalog_entries (id, slug, name, description, long_description, icon_url, homepage_url, transport, url, headers, command, args, env, tags, category_id, featured, sort_order, is_active, created_at, updated_at) VALUES ('mcp_agptofrydbzsrg6mgnzduktlkm', 'notion', 'Notion', 'Search, read and update Notion pages and databases. Authenticates via OAuth on first use.', NULL, NULL, 'https://developers.notion.com/docs/mcp', 'http', 'https://mcp.notion.com/mcp', NULL, NULL, NULL, NULL, '["docs", "tasks", "knowledge-base"]', NULL, false, 6, true, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.mcp_catalog_entries (id, slug, name, description, long_description, icon_url, homepage_url, transport, url, headers, command, args, env, tags, category_id, featured, sort_order, is_active, created_at, updated_at) VALUES ('mcp_agptofrydb3nrjcoki7uoffnim', 'linear', 'Linear', 'Create and manage Linear issues, projects and cycles. Authenticates via OAuth on first use.', NULL, NULL, 'https://linear.app/docs/mcp', 'http', 'https://mcp.linear.app/mcp', NULL, NULL, NULL, NULL, '["issues", "project-management"]', NULL, false, 7, true, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.mcp_catalog_entries (id, slug, name, description, long_description, icon_url, homepage_url, transport, url, headers, command, args, env, tags, category_id, featured, sort_order, is_active, created_at, updated_at) VALUES ('mcp_agptofrydbz5ffwfsooktma6ja', 'firecrawl', 'Firecrawl', 'Web scraping and crawling: turn any website into clean markdown or structured data. Requires a Firecrawl API key.', NULL, NULL, 'https://firecrawl.dev', 'stdio', NULL, NULL, 'npx', '["-y", "firecrawl-mcp"]', '{"FIRECRAWL_API_KEY": "${FIRECRAWL_API_KEY}"}', '["scraping", "web"]', NULL, false, 8, true, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.mcp_catalog_entries (id, slug, name, description, long_description, icon_url, homepage_url, transport, url, headers, command, args, env, tags, category_id, featured, sort_order, is_active, created_at, updated_at) VALUES ('mcp_agptofrydb7oplah67i4avspsa', 'exa', 'Exa Search', 'AI-native web search: semantic search, company research and content retrieval. Requires an Exa API key.', NULL, NULL, 'https://exa.ai', 'stdio', NULL, NULL, 'npx', '["-y", "exa-mcp-server"]', '{"EXA_API_KEY": "${EXA_API_KEY}"}', '["search", "research"]', NULL, false, 9, true, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.mcp_catalog_entries (id, slug, name, description, long_description, icon_url, homepage_url, transport, url, headers, command, args, env, tags, category_id, featured, sort_order, is_active, created_at, updated_at) VALUES ('mcp_agptofrydb5wtpjfdeelnqzpyy', 'memory', 'Memory', 'Reference knowledge-graph memory server: persist entities, relations and observations across agent sessions.', NULL, NULL, 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory', 'stdio', NULL, NULL, 'npx', '["-y", "@modelcontextprotocol/server-memory"]', NULL, '["memory", "knowledge-graph"]', NULL, false, 10, true, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
INSERT INTO public.mcp_catalog_entries (id, slug, name, description, long_description, icon_url, homepage_url, transport, url, headers, command, args, env, tags, category_id, featured, sort_order, is_active, created_at, updated_at) VALUES ('mcp_agptofrydbzzxof32fklaxix64', 'sequential-thinking', 'Sequential Thinking', 'Reference server for structured step-by-step reasoning: break complex problems into revisable thought sequences.', NULL, NULL, 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking', 'stdio', NULL, NULL, 'npx', '["-y", "@modelcontextprotocol/server-sequential-thinking"]', NULL, '["reasoning", "planning"]', NULL, false, 11, true, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00');
--> statement-breakpoint
INSERT INTO public.plans (id, name, max_agents_provisioned, max_concurrent_active, max_storage_gb, monthly_active_hours_included, created_at, updated_at, max_always_online_runtimes, max_always_online_agents, max_channels, max_automations, max_automation_runs_monthly, message_history_retention_days, monthly_api_request_limit) VALUES ('free', 'Free', 3, 1, 3, 5, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00', 1, 2, 2, 3, 30, 30, 5000);
INSERT INTO public.plans (id, name, max_agents_provisioned, max_concurrent_active, max_storage_gb, monthly_active_hours_included, created_at, updated_at, max_always_online_runtimes, max_always_online_agents, max_channels, max_automations, max_automation_runs_monthly, message_history_retention_days, monthly_api_request_limit) VALUES ('hobby', 'Hobby', 10, 3, 12, 20, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00', 3, 6, 8, 15, 300, 90, NULL);
INSERT INTO public.plans (id, name, max_agents_provisioned, max_concurrent_active, max_storage_gb, monthly_active_hours_included, created_at, updated_at, max_always_online_runtimes, max_always_online_agents, max_channels, max_automations, max_automation_runs_monthly, message_history_retention_days, monthly_api_request_limit) VALUES ('plus', 'Plus', 25, 5, 30, 60, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00', 10, 20, 25, 50, 1500, 180, NULL);
INSERT INTO public.plans (id, name, max_agents_provisioned, max_concurrent_active, max_storage_gb, monthly_active_hours_included, created_at, updated_at, max_always_online_runtimes, max_always_online_agents, max_channels, max_automations, max_automation_runs_monthly, message_history_retention_days, monthly_api_request_limit) VALUES ('pro', 'Pro', 75, 10, 80, 200, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00', 30, 100, 100, 200, NULL, NULL, NULL);
INSERT INTO public.plans (id, name, max_agents_provisioned, max_concurrent_active, max_storage_gb, monthly_active_hours_included, created_at, updated_at, max_always_online_runtimes, max_always_online_agents, max_channels, max_automations, max_automation_runs_monthly, message_history_retention_days, monthly_api_request_limit) VALUES ('self_hosted', 'Self-hosted', 1000000, 1000000, 1000000, NULL, '2026-08-18 11:36:09.479641+00', '2026-08-18 11:36:09.479641+00', 1000000, 1000000, 1000000, 1000000, NULL, NULL, NULL);
