INSERT INTO "framework_model_catalog" ("id", "framework", "model_key", "kind", "display_name", "capabilities", "sort_order", "is_active", "is_default")
VALUES
	('fmc_seed_codex_gpt6astra', 'codex', 'gpt-6-astra', 'model', 'GPT-6 Astra', '{"fast":true}'::jsonb, 0, true, false)
ON CONFLICT ("framework", "model_key") DO NOTHING;--> statement-breakpoint
INSERT INTO "framework_enum_catalog" ("id", "framework", "enum_key", "value", "display_name", "sort_order", "is_active", "is_default")
VALUES
	('fec_seed_codex_intel_max', 'codex', 'intelligence', 'max', 'Maximum', 60, true, false),
	('fec_seed_codex_intel_ultra', 'codex', 'intelligence', 'ultra', 'Ultra', 70, true, false)
ON CONFLICT ("framework", "enum_key", "value") DO NOTHING;--> statement-breakpoint
UPDATE "framework_model_catalog"
SET "is_active" = false, "is_default" = false, "updated_at" = NOW()
WHERE "framework" = 'codex'
  AND "model_key" = 'gpt-5.3-codex';
