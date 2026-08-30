CREATE TABLE IF NOT EXISTS "chat_permission_answers" (
	"message_id" text NOT NULL,
	"request_id" text NOT NULL,
	"option_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_permission_answers_message_id_request_id_pk" PRIMARY KEY("message_id","request_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_permission_answers" ADD CONSTRAINT "chat_permission_answers_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
