CREATE TABLE "automation_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"property_id" uuid,
	"name" text NOT NULL,
	"trigger" text NOT NULL,
	"offset_days" integer DEFAULT 0 NOT NULL,
	"send_hour" integer DEFAULT 10 NOT NULL,
	"template_key" text NOT NULL,
	"channels" jsonb NOT NULL,
	"sources" jsonb,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_rules_trigger_check" CHECK (trigger IN ('booking_confirmed','pre_arrival','check_in_day','post_stay','booking_cancelled')),
	CONSTRAINT "automation_rules_hour_check" CHECK (send_hour BETWEEN 0 AND 23),
	CONSTRAINT "automation_rules_offset_check" CHECK (offset_days BETWEEN 0 AND 365)
);
--> statement-breakpoint
CREATE TABLE "automation_sends" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"rule_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_sends_status_check" CHECK (status IN ('sent', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"property_id" uuid,
	"guest_id" uuid,
	"reservation_id" uuid,
	"channel" text NOT NULL,
	"connection_id" uuid,
	"external_thread_id" text NOT NULL,
	"contact_name" text NOT NULL,
	"contact_address" text,
	"subject" text,
	"status" text DEFAULT 'open' NOT NULL,
	"assigned_to" uuid,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone,
	"last_message_preview" text,
	"last_inbound_at" timestamp with time zone,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_channel_check" CHECK (channel IN ('email','whatsapp','ota')),
	CONSTRAINT "conversations_status_check" CHECK (status IN ('open','waiting','closed'))
);
--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"property_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"whatsapp_template" text,
	"whatsapp_params" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"kind" text DEFAULT 'text' NOT NULL,
	"body" text NOT NULL,
	"subject" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"external_id" text,
	"status" text NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent_by" uuid,
	"sender_name" text,
	"template_key" text,
	"automation_rule_id" uuid,
	"ai_drafted" boolean DEFAULT false NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	CONSTRAINT "messages_direction_check" CHECK (direction IN ('in','out')),
	CONSTRAINT "messages_kind_check" CHECK (kind IN ('text','note')),
	CONSTRAINT "messages_status_check" CHECK (status IN ('received','queued','sent','delivered','read','failed'))
);
--> statement-breakpoint
CREATE TABLE "online_checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"arrival_time" text,
	"guest_count" integer DEFAULT 0 NOT NULL,
	"data_enc" text,
	"signature_name" text,
	"terms_accepted_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"verified_by" uuid,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "online_checkins_status_check" CHECK (status IN ('started','submitted','verified'))
);
--> statement-breakpoint
CREATE TABLE "payment_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"folio_id" uuid,
	"purpose" text NOT NULL,
	"provider" text NOT NULL,
	"provider_order_id" text NOT NULL,
	"checkout_url" text NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'created' NOT NULL,
	"provider_payment_id" text,
	"payment_id" uuid,
	"failure_reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_orders_status_check" CHECK (status IN ('created','paid','failed','expired','cancelled')),
	CONSTRAINT "payment_orders_purpose_check" CHECK (purpose IN ('booking','payment_link')),
	CONSTRAINT "payment_orders_amount_check" CHECK (amount > 0)
);
--> statement-breakpoint
CREATE TABLE "promo_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"property_id" uuid,
	"code" "citext" NOT NULL,
	"description" text,
	"kind" text NOT NULL,
	"value" integer NOT NULL,
	"currency" text,
	"book_from" timestamp with time zone,
	"book_to" timestamp with time zone,
	"stay_from" date,
	"stay_to" date,
	"min_nights" integer DEFAULT 1 NOT NULL,
	"max_uses" integer,
	"used_count" integer DEFAULT 0 NOT NULL,
	"rate_plan_ids" jsonb,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_codes_kind_check" CHECK (kind IN ('percent','amount')),
	CONSTRAINT "promo_codes_value_check" CHECK (value > 0),
	CONSTRAINT "promo_codes_uses_check" CHECK (max_uses IS NULL OR max_uses > 0)
);
--> statement-breakpoint
CREATE TABLE "stored_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"property_id" uuid,
	"reservation_id" uuid,
	"guest_id" uuid,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"encrypted" boolean DEFAULT true NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_after" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "stored_files_kind_check" CHECK (kind IN ('id_document','message_attachment','other'))
);
--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "promo_code_id" uuid;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "promo_code" text;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "discount_amount" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "guest_token_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "online_checkin_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_sends" ADD CONSTRAINT "automation_sends_rule_id_automation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."automation_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_sends" ADD CONSTRAINT "automation_sends_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_sends" ADD CONSTRAINT "automation_sends_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_connection_id_channel_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."channel_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "online_checkins" ADD CONSTRAINT "online_checkins_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "online_checkins" ADD CONSTRAINT "online_checkins_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_folio_id_folios_id_fk" FOREIGN KEY ("folio_id") REFERENCES "public"."folios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_rules_org_idx" ON "automation_rules" USING btree ("org_id","trigger");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_sends_key" ON "automation_sends" USING btree ("rule_id","reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_thread_key" ON "conversations" USING btree ("org_id","channel","external_thread_id");--> statement-breakpoint
CREATE INDEX "conversations_inbox_idx" ON "conversations" USING btree ("org_id","status","last_message_at");--> statement-breakpoint
CREATE INDEX "conversations_reservation_idx" ON "conversations" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "conversations_guest_idx" ON "conversations" USING btree ("guest_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_templates_key" ON "message_templates" USING btree ("org_id","key","language") WHERE property_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "message_templates_property_key" ON "message_templates" USING btree ("property_id","key","language") WHERE property_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_external_key" ON "messages" USING btree ("conversation_id","external_id") WHERE external_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_queue_idx" ON "messages" USING btree ("created_at") WHERE status = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX "online_checkins_reservation_key" ON "online_checkins" USING btree ("reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_orders_provider_key" ON "payment_orders" USING btree ("provider","provider_order_id");--> statement-breakpoint
CREATE INDEX "payment_orders_reservation_idx" ON "payment_orders" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "payment_orders_open_idx" ON "payment_orders" USING btree ("expires_at") WHERE status = 'created';--> statement-breakpoint
CREATE UNIQUE INDEX "promo_codes_org_code_key" ON "promo_codes" USING btree ("org_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "stored_files_key" ON "stored_files" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "stored_files_reservation_idx" ON "stored_files" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "stored_files_retention_idx" ON "stored_files" USING btree ("delete_after") WHERE deleted_at IS NULL AND delete_after IS NOT NULL;