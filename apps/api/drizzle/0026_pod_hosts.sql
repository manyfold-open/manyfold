ALTER TABLE "runtime_hosts" ADD COLUMN "cluster_id" text;--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD COLUMN "namespace" text;--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD COLUMN "ingress_host" text;--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD COLUMN "cpu_millicores" integer;--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD COLUMN "memory_mb" integer;--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD COLUMN "disk_gb" integer;--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD COLUMN "pod_status" text;--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD COLUMN "pod_phase" text;--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD COLUMN "pod_failure_reason" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "runtime_hosts" ADD CONSTRAINT "runtime_hosts_cluster_id_k8s_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."k8s_clusters"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_runtimes_pod_host_framework_uq" ON "agent_runtimes" USING btree ("host_id","framework") WHERE "agent_runtimes"."kind" = 'k8s' and "agent_runtimes"."status" not in ('failed', 'stopped');