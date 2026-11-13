CREATE TABLE "ai_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"property_id" uuid,
	"tool" text NOT NULL,
	"params" jsonb NOT NULL,
	"summary" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"result" jsonb,
	"error" text,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_actions_status_check" CHECK (status IN ('proposed','confirmed','rejected','expired','failed'))
);
--> statement-breakpoint
CREATE TABLE "ai_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"feature" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"ok" boolean DEFAULT true NOT NULL,
	"error" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"rate_plan_id" uuid NOT NULL,
	"date" date NOT NULL,
	"current_rate" bigint NOT NULL,
	"recommended_rate" bigint NOT NULL,
	"occupancy_bp" integer NOT NULL,
	"forecast_bp" integer NOT NULL,
	"drivers" jsonb NOT NULL,
	"confidence" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"applied_via" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_recommendations_status_check" CHECK (status IN ('pending','applied','dismissed','superseded'))
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"connection_id" uuid,
	"external_id" text NOT NULL,
	"channel_code" text,
	"reservation_id" uuid,
	"ota_reservation_code" text,
	"guest_name" text,
	"overall_score" integer,
	"scores" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content" text,
	"received_at" timestamp with time zone NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"reply" text,
	"reply_status" text DEFAULT 'none' NOT NULL,
	"reply_error" text,
	"replied_at" timestamp with time zone,
	"replied_by" uuid,
	"sentiment" text,
	"topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text,
	"language" text,
	"analysed_by" text,
	"analysed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_sentiment_check" CHECK (sentiment IS NULL OR sentiment IN ('positive','neutral','negative')),
	CONSTRAINT "reviews_reply_status_check" CHECK (reply_status IN ('none','queued','sent','failed'))
);
--> statement-breakpoint
ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_recommendations" ADD CONSTRAINT "rate_recommendations_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_recommendations" ADD CONSTRAINT "rate_recommendations_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_recommendations" ADD CONSTRAINT "rate_recommendations_rate_plan_id_rate_plans_id_fk" FOREIGN KEY ("rate_plan_id") REFERENCES "public"."rate_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_recommendations" ADD CONSTRAINT "rate_recommendations_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_connection_id_channel_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."channel_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_replied_by_users_id_fk" FOREIGN KEY ("replied_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_actions_user_idx" ON "ai_actions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_runs_org_idx" ON "ai_runs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rate_recommendations_pending_key" ON "rate_recommendations" USING btree ("rate_plan_id","date") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "rate_recommendations_property_idx" ON "rate_recommendations" USING btree ("property_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_external_key" ON "reviews" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX "reviews_property_idx" ON "reviews" USING btree ("property_id","received_at");