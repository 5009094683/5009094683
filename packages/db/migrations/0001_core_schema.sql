CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" uuid,
	"actor_label" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"property_id" uuid,
	"summary" text,
	"changes" jsonb,
	"ip" text,
	"request_id" text,
	CONSTRAINT "audit_log_actor_type_check" CHECK (actor_type IN ('user','system','channel','api_key','copilot','guest'))
);
--> statement-breakpoint
CREATE TABLE "oidc_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_enc" text,
	"scopes" text DEFAULT 'openid email profile' NOT NULL,
	"allowed_email_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"auto_provision" boolean DEFAULT false NOT NULL,
	"default_role" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"default_currency" text DEFAULT 'INR' NOT NULL,
	"default_timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"property_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_assignments_unique" UNIQUE NULLS NOT DISTINCT("user_id","role","property_id"),
	CONSTRAINT "role_assignments_role_check" CHECK (role IN ('org_admin','general_manager','revenue_manager','front_desk','housekeeping','maintenance','accountant','read_only','villa_owner'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"auth_method" text NOT NULL,
	"mfa_pending" boolean DEFAULT false NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"email" "citext",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" "citext" NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"password_hash" text,
	"totp_secret_enc" text,
	"totp_enabled_at" timestamp with time zone,
	"totp_last_step" bigint,
	"recovery_code_hashes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_status_check" CHECK (status IN ('active','invited','disabled'))
);
--> statement-breakpoint
CREATE TABLE "inventory_days" (
	"room_type_id" uuid NOT NULL,
	"date" date NOT NULL,
	"property_id" uuid NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"sold" integer DEFAULT 0 NOT NULL,
	"blocked" integer DEFAULT 0 NOT NULL,
	"out_of_order" integer DEFAULT 0 NOT NULL,
	"linked" integer DEFAULT 0 NOT NULL,
	"overbooked" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_days_room_type_id_date_pk" PRIMARY KEY("room_type_id","date"),
	CONSTRAINT "inventory_days_non_negative" CHECK (total >= 0 AND sold >= 0 AND blocked >= 0 AND out_of_order >= 0 AND linked >= 0 AND overbooked >= 0),
	CONSTRAINT "not_oversold" CHECK (sold + blocked + out_of_order + linked <= total)
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"state" text,
	"state_code" text,
	"postal_code" text,
	"country" text DEFAULT 'IN' NOT NULL,
	"phone" text,
	"email" "citext",
	"legal_name" text,
	"gstin" text,
	"check_in_time" text DEFAULT '14:00' NOT NULL,
	"check_out_time" text DEFAULT '11:00' NOT NULL,
	"inventory_horizon_days" integer DEFAULT 540 NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "properties_kind_check" CHECK (kind IN ('hotel','villa')),
	CONSTRAINT "properties_horizon_check" CHECK (inventory_horizon_days BETWEEN 30 AND 1095)
);
--> statement-breakpoint
CREATE TABLE "rate_days" (
	"rate_plan_id" uuid NOT NULL,
	"date" date NOT NULL,
	"rate" bigint,
	"min_stay_arrival" integer,
	"min_stay_through" integer,
	"max_stay" integer,
	"closed_to_arrival" boolean DEFAULT false NOT NULL,
	"closed_to_departure" boolean DEFAULT false NOT NULL,
	"stop_sell" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_days_rate_plan_id_date_pk" PRIMARY KEY("rate_plan_id","date"),
	CONSTRAINT "rate_days_rate_check" CHECK (rate IS NULL OR rate >= 0),
	CONSTRAINT "rate_days_stay_check" CHECK ((min_stay_arrival IS NULL OR min_stay_arrival >= 1) AND (min_stay_through IS NULL OR min_stay_through >= 1) AND (max_stay IS NULL OR max_stay >= 1))
);
--> statement-breakpoint
CREATE TABLE "rate_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"currency" text NOT NULL,
	"base_rate" bigint NOT NULL,
	"included_occupancy" integer DEFAULT 2 NOT NULL,
	"extra_adult_rate" bigint DEFAULT 0 NOT NULL,
	"extra_child_rate" bigint DEFAULT 0 NOT NULL,
	"meal_plan" text DEFAULT 'room_only' NOT NULL,
	"cancellation_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"min_stay" integer DEFAULT 1 NOT NULL,
	"max_stay" integer,
	"parent_rate_plan_id" uuid,
	"derived_percent_bp" integer DEFAULT 0 NOT NULL,
	"derived_amount" bigint DEFAULT 0 NOT NULL,
	"floor_rate" bigint,
	"ceiling_rate" bigint,
	"is_default" boolean DEFAULT false NOT NULL,
	"public_bookable" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_plans_meal_plan_check" CHECK (meal_plan IN ('room_only','breakfast','half_board','full_board','all_inclusive')),
	CONSTRAINT "rate_plans_base_rate_check" CHECK (base_rate >= 0),
	CONSTRAINT "rate_plans_min_stay_check" CHECK (min_stay >= 1 AND (max_stay IS NULL OR max_stay >= min_stay)),
	CONSTRAINT "rate_plans_floor_ceiling_check" CHECK (floor_rate IS NULL OR ceiling_rate IS NULL OR floor_rate <= ceiling_rate)
);
--> statement-breakpoint
CREATE TABLE "room_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"base_occupancy" integer DEFAULT 2 NOT NULL,
	"max_adults" integer DEFAULT 2 NOT NULL,
	"max_children" integer DEFAULT 0 NOT NULL,
	"max_occupancy" integer DEFAULT 2 NOT NULL,
	"assignment" text DEFAULT 'at_check_in' NOT NULL,
	"amenities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_types_assignment_check" CHECK (assignment IN ('at_booking','at_check_in')),
	CONSTRAINT "room_types_occupancy_check" CHECK (base_occupancy >= 1 AND max_adults >= 1 AND max_children >= 0 AND max_occupancy >= base_occupancy)
);
--> statement-breakpoint
CREATE TABLE "units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"name" text NOT NULL,
	"floor" text,
	"parent_unit_id" uuid,
	"housekeeping_status" text DEFAULT 'clean' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "units_not_own_parent" CHECK (parent_unit_id IS NULL OR parent_unit_id <> id),
	CONSTRAINT "units_housekeeping_status_check" CHECK (housekeeping_status IN ('clean','dirty','inspected','out_of_service'))
);
--> statement-breakpoint
CREATE TABLE "guests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text DEFAULT '' NOT NULL,
	"email" "citext",
	"phone" text,
	"language" text,
	"nationality" text,
	"date_of_birth" date,
	"address_line1" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"country" text,
	"company" text,
	"gstin" text,
	"id_type" text,
	"id_number_enc" text,
	"id_expiry" date,
	"notes" text,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"vip" boolean DEFAULT false NOT NULL,
	"blacklisted" boolean DEFAULT false NOT NULL,
	"marketing_consent" boolean DEFAULT false NOT NULL,
	"anonymized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"unit_id" uuid,
	"kind" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"reason" text,
	"notes" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"connection_id" uuid,
	"external_ref" text,
	"owner_id" uuid,
	"group_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"released_by" uuid,
	CONSTRAINT "inventory_blocks_dates_check" CHECK (end_date > start_date),
	CONSTRAINT "inventory_blocks_kind_check" CHECK (kind IN ('block','maintenance','owner_stay','hold')),
	CONSTRAINT "inventory_blocks_source_check" CHECK (source IN ('manual','ical','email','system','housekeeping')),
	CONSTRAINT "inventory_blocks_quantity_check" CHECK (quantity >= 1 AND (unit_id IS NULL OR quantity = 1))
);
--> statement-breakpoint
CREATE TABLE "reservation_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"contact_name" text,
	"contact_email" "citext",
	"contact_phone" text,
	"cutoff_date" date,
	"status" text DEFAULT 'open' NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reservation_nights" (
	"reservation_room_id" uuid NOT NULL,
	"date" date NOT NULL,
	"amount" bigint NOT NULL,
	CONSTRAINT "reservation_nights_reservation_room_id_date_pk" PRIMARY KEY("reservation_room_id","date")
);
--> statement-breakpoint
CREATE TABLE "reservation_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"rate_plan_id" uuid,
	"unit_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"check_in" date NOT NULL,
	"check_out" date NOT NULL,
	"adults" integer DEFAULT 1 NOT NULL,
	"children" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"guest_name" text,
	"amount" bigint DEFAULT 0 NOT NULL,
	"external_room_ref" text,
	"checked_in_at" timestamp with time zone,
	"checked_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservation_rooms_dates_check" CHECK (check_out > check_in),
	CONSTRAINT "reservation_rooms_status_check" CHECK (status IN ('tentative','confirmed','in_house','checked_out','cancelled','no_show')),
	CONSTRAINT "reservation_rooms_occupancy_check" CHECK (adults >= 1 AND children >= 0)
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"code" text NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"channel_code" text,
	"connection_id" uuid,
	"external_id" text,
	"channel_reservation_code" text,
	"external_revision_at" timestamp with time zone,
	"guest_id" uuid,
	"guest_name" text NOT NULL,
	"check_in" date NOT NULL,
	"check_out" date NOT NULL,
	"adults" integer DEFAULT 1 NOT NULL,
	"children" integer DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"total_amount" bigint DEFAULT 0 NOT NULL,
	"commission_amount" bigint DEFAULT 0 NOT NULL,
	"payment_collect" text DEFAULT 'property' NOT NULL,
	"arrival_time" text,
	"special_requests" text,
	"notes" text,
	"hold_expires_at" timestamp with time zone,
	"group_id" uuid,
	"company_id" uuid,
	"overbooked" boolean DEFAULT false NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"review_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	CONSTRAINT "reservations_dates_check" CHECK (check_out > check_in),
	CONSTRAINT "reservations_status_check" CHECK (status IN ('tentative','confirmed','in_house','checked_out','cancelled','no_show')),
	CONSTRAINT "reservations_source_check" CHECK (source IN ('direct','walk_in','phone','website','ota','corporate','travel_agent','owner','group')),
	CONSTRAINT "reservations_payment_collect_check" CHECK (payment_collect IN ('property','channel'))
);
--> statement-breakpoint
CREATE TABLE "unit_occupancy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"source_unit_id" uuid NOT NULL,
	"stay" daterange NOT NULL,
	"reservation_room_id" uuid,
	"block_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unit_occupancy_stay_check" CHECK (NOT isempty(stay)),
	CONSTRAINT "unit_occupancy_one_source" CHECK ((reservation_room_id IS NOT NULL) <> (block_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "booking_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_revision_id" text NOT NULL,
	"external_booking_id" text NOT NULL,
	"channel_code" text,
	"received_via" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision_at" timestamp with time zone NOT NULL,
	"raw" jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"applied_at" timestamp with time zone,
	"acked_at" timestamp with time zone,
	"ack_attempts" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"reservation_id" uuid,
	CONSTRAINT "booking_revisions_status_check" CHECK (status IN ('received','applied','superseded','unmapped','failed'))
);
--> statement-breakpoint
CREATE TABLE "channel_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"adapter" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets_enc" text,
	"last_push_at" timestamp with time zone,
	"last_pull_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"full_sync_requested_at" timestamp with time zone,
	"last_full_sync_at" timestamp with time zone,
	"last_drift_check_at" timestamp with time zone,
	"last_drift_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_connections_adapter_check" CHECK (adapter IN ('channex','ical','email')),
	CONSTRAINT "channel_connections_status_check" CHECK (status IN ('pending','active','paused','error','disabled'))
);
--> statement-breakpoint
CREATE TABLE "channel_rate_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"rate_plan_id" uuid NOT NULL,
	"external_rate_plan_id" text NOT NULL,
	"external_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_room_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"external_room_type_id" text NOT NULL,
	"external_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"operation" text NOT NULL,
	"status" text NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"lag_ms" integer,
	"error" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_queue" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"room_type_id" uuid NOT NULL,
	"rate_plan_id" uuid,
	"date_from" date NOT NULL,
	"date_to" date NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_queue_kind_check" CHECK (kind IN ('availability','restrictions')),
	CONSTRAINT "sync_queue_dates_check" CHECK (date_to > date_from)
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"event_type" text,
	"connection_id" uuid,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"property_id" uuid,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"entity_type" text,
	"entity_id" text,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "alerts_severity_check" CHECK (severity IN ('info','warning','critical')),
	CONSTRAINT "alerts_status_check" CHECK (status IN ('open','acknowledged','resolved'))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"unique_key" text,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "jobs_status_check" CHECK (status IN ('pending','running','done','failed'))
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"org_id" uuid NOT NULL,
	"property_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oidc_providers" ADD CONSTRAINT "oidc_providers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_provider_id_oidc_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."oidc_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_days" ADD CONSTRAINT "inventory_days_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_days" ADD CONSTRAINT "inventory_days_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_days" ADD CONSTRAINT "rate_days_rate_plan_id_rate_plans_id_fk" FOREIGN KEY ("rate_plan_id") REFERENCES "public"."rate_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_plans" ADD CONSTRAINT "rate_plans_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_plans" ADD CONSTRAINT "rate_plans_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_plans" ADD CONSTRAINT "rate_plans_parent_rate_plan_id_rate_plans_id_fk" FOREIGN KEY ("parent_rate_plan_id") REFERENCES "public"."rate_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_types" ADD CONSTRAINT "room_types_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_parent_unit_id_units_id_fk" FOREIGN KEY ("parent_unit_id") REFERENCES "public"."units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guests" ADD CONSTRAINT "guests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_blocks" ADD CONSTRAINT "inventory_blocks_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_blocks" ADD CONSTRAINT "inventory_blocks_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_blocks" ADD CONSTRAINT "inventory_blocks_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_blocks" ADD CONSTRAINT "inventory_blocks_connection_id_channel_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."channel_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_blocks" ADD CONSTRAINT "inventory_blocks_group_id_reservation_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."reservation_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_blocks" ADD CONSTRAINT "inventory_blocks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_blocks" ADD CONSTRAINT "inventory_blocks_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_groups" ADD CONSTRAINT "reservation_groups_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_groups" ADD CONSTRAINT "reservation_groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_nights" ADD CONSTRAINT "reservation_nights_reservation_room_id_reservation_rooms_id_fk" FOREIGN KEY ("reservation_room_id") REFERENCES "public"."reservation_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_rooms" ADD CONSTRAINT "reservation_rooms_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_rooms" ADD CONSTRAINT "reservation_rooms_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_rooms" ADD CONSTRAINT "reservation_rooms_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_rooms" ADD CONSTRAINT "reservation_rooms_rate_plan_id_rate_plans_id_fk" FOREIGN KEY ("rate_plan_id") REFERENCES "public"."rate_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_rooms" ADD CONSTRAINT "reservation_rooms_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_connection_id_channel_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."channel_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_group_id_reservation_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."reservation_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_occupancy" ADD CONSTRAINT "unit_occupancy_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_occupancy" ADD CONSTRAINT "unit_occupancy_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_occupancy" ADD CONSTRAINT "unit_occupancy_source_unit_id_units_id_fk" FOREIGN KEY ("source_unit_id") REFERENCES "public"."units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_occupancy" ADD CONSTRAINT "unit_occupancy_reservation_room_id_reservation_rooms_id_fk" FOREIGN KEY ("reservation_room_id") REFERENCES "public"."reservation_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_occupancy" ADD CONSTRAINT "unit_occupancy_block_id_inventory_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."inventory_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_revisions" ADD CONSTRAINT "booking_revisions_connection_id_channel_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."channel_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_revisions" ADD CONSTRAINT "booking_revisions_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_rate_mappings" ADD CONSTRAINT "channel_rate_mappings_connection_id_channel_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."channel_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_rate_mappings" ADD CONSTRAINT "channel_rate_mappings_rate_plan_id_rate_plans_id_fk" FOREIGN KEY ("rate_plan_id") REFERENCES "public"."rate_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_room_mappings" ADD CONSTRAINT "channel_room_mappings_connection_id_channel_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."channel_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_room_mappings" ADD CONSTRAINT "channel_room_mappings_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_log" ADD CONSTRAINT "sync_log_connection_id_channel_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."channel_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_queue" ADD CONSTRAINT "sync_queue_connection_id_channel_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."channel_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_queue" ADD CONSTRAINT "sync_queue_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_queue" ADD CONSTRAINT "sync_queue_rate_plan_id_rate_plans_id_fk" FOREIGN KEY ("rate_plan_id") REFERENCES "public"."rate_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_org_at_idx" ON "audit_log" USING btree ("org_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_user_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "oidc_providers_slug_key" ON "oidc_providers" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "role_assignments_user_idx" ON "role_assignments" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_provider_subject_key" ON "user_identities" USING btree ("provider_id","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "user_tokens_token_hash_key" ON "user_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "user_tokens_user_idx" ON "user_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_org_idx" ON "users" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "inventory_days_property_date_idx" ON "inventory_days" USING btree ("property_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "properties_org_code_key" ON "properties" USING btree ("org_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "rate_plans_property_code_key" ON "rate_plans" USING btree ("property_id","code");--> statement-breakpoint
CREATE INDEX "rate_plans_room_type_idx" ON "rate_plans" USING btree ("room_type_id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_types_property_code_key" ON "room_types" USING btree ("property_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "units_property_name_key" ON "units" USING btree ("property_id","name");--> statement-breakpoint
CREATE INDEX "units_room_type_idx" ON "units" USING btree ("room_type_id");--> statement-breakpoint
CREATE INDEX "units_parent_idx" ON "units" USING btree ("parent_unit_id");--> statement-breakpoint
CREATE INDEX "guests_org_email_idx" ON "guests" USING btree ("org_id","email");--> statement-breakpoint
CREATE INDEX "guests_org_phone_idx" ON "guests" USING btree ("org_id","phone");--> statement-breakpoint
CREATE INDEX "guests_org_name_idx" ON "guests" USING btree ("org_id","last_name","first_name");--> statement-breakpoint
CREATE INDEX "inventory_blocks_type_dates_idx" ON "inventory_blocks" USING btree ("room_type_id","start_date","end_date");--> statement-breakpoint
CREATE INDEX "inventory_blocks_property_dates_idx" ON "inventory_blocks" USING btree ("property_id","start_date","end_date");--> statement-breakpoint
CREATE INDEX "inventory_blocks_unit_idx" ON "inventory_blocks" USING btree ("unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_blocks_external_key" ON "inventory_blocks" USING btree ("connection_id","external_ref") WHERE external_ref IS NOT NULL AND released_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "reservation_groups_property_code_key" ON "reservation_groups" USING btree ("property_id","code");--> statement-breakpoint
CREATE INDEX "reservation_nights_date_idx" ON "reservation_nights" USING btree ("date");--> statement-breakpoint
CREATE INDEX "reservation_rooms_reservation_idx" ON "reservation_rooms" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "reservation_rooms_type_dates_idx" ON "reservation_rooms" USING btree ("room_type_id","check_in","check_out");--> statement-breakpoint
CREATE INDEX "reservation_rooms_unit_idx" ON "reservation_rooms" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "reservation_rooms_property_dates_idx" ON "reservation_rooms" USING btree ("property_id","check_in","check_out");--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_code_key" ON "reservations" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_connection_external_key" ON "reservations" USING btree ("connection_id","external_id") WHERE external_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "reservations_property_checkin_idx" ON "reservations" USING btree ("property_id","check_in");--> statement-breakpoint
CREATE INDEX "reservations_property_checkout_idx" ON "reservations" USING btree ("property_id","check_out");--> statement-breakpoint
CREATE INDEX "reservations_property_status_idx" ON "reservations" USING btree ("property_id","status");--> statement-breakpoint
CREATE INDEX "reservations_guest_idx" ON "reservations" USING btree ("guest_id");--> statement-breakpoint
CREATE INDEX "reservations_hold_idx" ON "reservations" USING btree ("hold_expires_at") WHERE status = 'tentative';--> statement-breakpoint
CREATE INDEX "unit_occupancy_reservation_room_idx" ON "unit_occupancy" USING btree ("reservation_room_id");--> statement-breakpoint
CREATE INDEX "unit_occupancy_block_idx" ON "unit_occupancy" USING btree ("block_id");--> statement-breakpoint
CREATE INDEX "unit_occupancy_source_unit_idx" ON "unit_occupancy" USING btree ("source_unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_revisions_external_key" ON "booking_revisions" USING btree ("connection_id","external_revision_id");--> statement-breakpoint
CREATE INDEX "booking_revisions_booking_idx" ON "booking_revisions" USING btree ("connection_id","external_booking_id");--> statement-breakpoint
CREATE INDEX "booking_revisions_pending_idx" ON "booking_revisions" USING btree ("status","received_at") WHERE status IN ('received', 'failed') OR acked_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_connections_property_adapter_key" ON "channel_connections" USING btree ("property_id","adapter");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_rate_mappings_rate_key" ON "channel_rate_mappings" USING btree ("connection_id","rate_plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_rate_mappings_external_key" ON "channel_rate_mappings" USING btree ("connection_id","external_rate_plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_room_mappings_room_key" ON "channel_room_mappings" USING btree ("connection_id","room_type_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_room_mappings_external_key" ON "channel_room_mappings" USING btree ("connection_id","external_room_type_id");--> statement-breakpoint
CREATE INDEX "sync_log_connection_idx" ON "sync_log" USING btree ("connection_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sync_queue_connection_idx" ON "sync_queue" USING btree ("connection_id","id");--> statement-breakpoint
CREATE INDEX "webhook_events_source_idx" ON "webhook_events" USING btree ("source","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_open_dedupe_key" ON "alerts" USING btree ("dedupe_key") WHERE status <> 'resolved';--> statement-breakpoint
CREATE INDEX "alerts_org_status_idx" ON "alerts" USING btree ("org_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "jobs_due_idx" ON "jobs" USING btree ("run_at") WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_unique_key" ON "jobs" USING btree ("unique_key") WHERE unique_key IS NOT NULL AND status IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX "jobs_kind_idx" ON "jobs" USING btree ("kind","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "outbox_created_idx" ON "outbox" USING btree ("created_at");