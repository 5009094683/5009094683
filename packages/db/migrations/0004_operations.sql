CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text DEFAULT 'corporate' NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"gstin" text,
	"address_line1" text,
	"city" text,
	"state" text,
	"state_code" text,
	"postal_code" text,
	"country" text DEFAULT 'IN' NOT NULL,
	"email" "citext",
	"phone" text,
	"contact_name" text,
	"credit_limit" bigint,
	"payment_terms_days" integer DEFAULT 30 NOT NULL,
	"commission_bp" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_kind_check" CHECK (kind IN ('corporate','travel_agent'))
);
--> statement-breakpoint
CREATE TABLE "daily_stats" (
	"property_id" uuid NOT NULL,
	"date" date NOT NULL,
	"available_rooms" integer NOT NULL,
	"sold_rooms" integer NOT NULL,
	"out_of_order" integer DEFAULT 0 NOT NULL,
	"arrivals" integer DEFAULT 0 NOT NULL,
	"departures" integer DEFAULT 0 NOT NULL,
	"no_shows" integer DEFAULT 0 NOT NULL,
	"cancellations" integer DEFAULT 0 NOT NULL,
	"room_revenue" bigint DEFAULT 0 NOT NULL,
	"other_revenue" bigint DEFAULT 0 NOT NULL,
	"tax_amount" bigint DEFAULT 0 NOT NULL,
	"payments_received" bigint DEFAULT 0 NOT NULL,
	"by_channel" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_stats_property_id_date_pk" PRIMARY KEY("property_id","date")
);
--> statement-breakpoint
CREATE TABLE "folio_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"folio_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"amount" bigint NOT NULL,
	"tax_amount" bigint DEFAULT 0 NOT NULL,
	"taxes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"service_code" text,
	"reservation_room_id" uuid,
	"payment_id" uuid,
	"invoice_id" uuid,
	"counterpart_line_id" uuid,
	"source" text DEFAULT 'manual' NOT NULL,
	"posted_by" uuid,
	"posted_by_label" text,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "folio_lines_kind_check" CHECK (kind IN ('room','food','service','extra','fee','discount','payment','refund','transfer')),
	CONSTRAINT "folio_lines_quantity_check" CHECK (quantity >= 1)
);
--> statement-breakpoint
CREATE TABLE "folios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"reservation_id" uuid,
	"company_id" uuid,
	"kind" text DEFAULT 'guest' NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"currency" text NOT NULL,
	"bill_to" jsonb NOT NULL,
	"routes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "folios_kind_check" CHECK (kind IN ('guest','company','house')),
	CONSTRAINT "folios_status_check" CHECK (status IN ('open','closed'))
);
--> statement-breakpoint
CREATE TABLE "housekeeping_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"date" date NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"assigned_to" uuid,
	"notes" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "housekeeping_tasks_kind_check" CHECK (kind IN ('departure','stayover','touch_up','deep_clean','inspection')),
	CONSTRAINT "housekeeping_tasks_status_check" CHECK (status IN ('pending','in_progress','done','skipped')),
	CONSTRAINT "housekeeping_tasks_priority_check" CHECK (priority IN ('low','normal','high','urgent'))
);
--> statement-breakpoint
CREATE TABLE "invoice_sequences" (
	"property_id" uuid NOT NULL,
	"type" text NOT NULL,
	"fiscal_year" text NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "invoice_sequences_property_id_type_fiscal_year_pk" PRIMARY KEY("property_id","type","fiscal_year")
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"folio_id" uuid NOT NULL,
	"type" text NOT NULL,
	"number" text NOT NULL,
	"fiscal_year" text NOT NULL,
	"sequence" integer NOT NULL,
	"issued_on" date NOT NULL,
	"related_invoice_id" uuid,
	"reason" text,
	"currency" text NOT NULL,
	"seller" jsonb NOT NULL,
	"buyer" jsonb NOT NULL,
	"lines" jsonb NOT NULL,
	"totals" jsonb NOT NULL,
	"reference" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_type_check" CHECK (type IN ('invoice','credit_note'))
);
--> statement-breakpoint
CREATE TABLE "maintenance_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"block_id" uuid,
	"reported_by" uuid,
	"reported_by_label" text,
	"assigned_to" uuid,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_issues_status_check" CHECK (status IN ('open','in_progress','resolved','closed')),
	CONSTRAINT "maintenance_issues_priority_check" CHECK (priority IN ('low','normal','high','urgent'))
);
--> statement-breakpoint
CREATE TABLE "night_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"status" text NOT NULL,
	"summary" jsonb NOT NULL,
	"error" text,
	"run_by" uuid,
	"run_by_label" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"folio_id" uuid NOT NULL,
	"method" text NOT NULL,
	"status" text DEFAULT 'captured' NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"reference" text,
	"provider" text,
	"provider_payment_id" text,
	"provider_order_id" text,
	"refund_of_payment_id" uuid,
	"note" text,
	"received_by" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_method_check" CHECK (method IN ('cash','card','upi','bank_transfer','online','channel','other')),
	CONSTRAINT "payments_status_check" CHECK (status IN ('pending','captured','failed','voided')),
	CONSTRAINT "payments_amount_check" CHECK (amount <> 0)
);
--> statement-breakpoint
CREATE TABLE "tax_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"category" text NOT NULL,
	"name" text NOT NULL,
	"service_code" text,
	"slabs" jsonb NOT NULL,
	"components" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_rules_category_check" CHECK (category IN ('room','food','service','extra','fee'))
);
--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "business_date" date;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_stats" ADD CONSTRAINT "daily_stats_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_lines" ADD CONSTRAINT "folio_lines_folio_id_folios_id_fk" FOREIGN KEY ("folio_id") REFERENCES "public"."folios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_lines" ADD CONSTRAINT "folio_lines_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_lines" ADD CONSTRAINT "folio_lines_reservation_room_id_reservation_rooms_id_fk" FOREIGN KEY ("reservation_room_id") REFERENCES "public"."reservation_rooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_lines" ADD CONSTRAINT "folio_lines_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_lines" ADD CONSTRAINT "folio_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_lines" ADD CONSTRAINT "folio_lines_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_lines" ADD CONSTRAINT "folio_lines_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folios" ADD CONSTRAINT "folios_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folios" ADD CONSTRAINT "folios_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folios" ADD CONSTRAINT "folios_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "housekeeping_tasks" ADD CONSTRAINT "housekeeping_tasks_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "housekeeping_tasks" ADD CONSTRAINT "housekeeping_tasks_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "housekeeping_tasks" ADD CONSTRAINT "housekeeping_tasks_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "housekeeping_tasks" ADD CONSTRAINT "housekeeping_tasks_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_sequences" ADD CONSTRAINT "invoice_sequences_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_folio_id_folios_id_fk" FOREIGN KEY ("folio_id") REFERENCES "public"."folios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_related_invoice_id_invoices_id_fk" FOREIGN KEY ("related_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_issues" ADD CONSTRAINT "maintenance_issues_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_issues" ADD CONSTRAINT "maintenance_issues_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_issues" ADD CONSTRAINT "maintenance_issues_block_id_inventory_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."inventory_blocks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_issues" ADD CONSTRAINT "maintenance_issues_reported_by_users_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_issues" ADD CONSTRAINT "maintenance_issues_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "night_audits" ADD CONSTRAINT "night_audits_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "night_audits" ADD CONSTRAINT "night_audits_run_by_users_id_fk" FOREIGN KEY ("run_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_folio_id_folios_id_fk" FOREIGN KEY ("folio_id") REFERENCES "public"."folios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_refund_of_payment_id_payments_id_fk" FOREIGN KEY ("refund_of_payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rules" ADD CONSTRAINT "tax_rules_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "companies_org_name_idx" ON "companies" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "folio_lines_folio_idx" ON "folio_lines" USING btree ("folio_id","business_date");--> statement-breakpoint
CREATE INDEX "folio_lines_property_date_idx" ON "folio_lines" USING btree ("property_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "folio_lines_room_night_key" ON "folio_lines" USING btree ("reservation_room_id","business_date") WHERE kind = 'room' AND voided_at IS NULL;--> statement-breakpoint
CREATE INDEX "folios_reservation_idx" ON "folios" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "folios_company_idx" ON "folios" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "folios_company_account_key" ON "folios" USING btree ("property_id","company_id") WHERE kind = 'company' AND reservation_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "housekeeping_tasks_unit_day_key" ON "housekeeping_tasks" USING btree ("unit_id","date","kind");--> statement-breakpoint
CREATE INDEX "housekeeping_tasks_property_day_idx" ON "housekeeping_tasks" USING btree ("property_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_property_number_key" ON "invoices" USING btree ("property_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_sequence_key" ON "invoices" USING btree ("property_id","type","fiscal_year","sequence");--> statement-breakpoint
CREATE INDEX "invoices_folio_idx" ON "invoices" USING btree ("folio_id");--> statement-breakpoint
CREATE INDEX "invoices_property_date_idx" ON "invoices" USING btree ("property_id","issued_on");--> statement-breakpoint
CREATE INDEX "maintenance_issues_property_idx" ON "maintenance_issues" USING btree ("property_id","status");--> statement-breakpoint
CREATE INDEX "maintenance_issues_unit_idx" ON "maintenance_issues" USING btree ("unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "night_audits_day_key" ON "night_audits" USING btree ("property_id","business_date") WHERE status = 'completed';--> statement-breakpoint
CREATE INDEX "night_audits_property_idx" ON "night_audits" USING btree ("property_id","business_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payments_folio_idx" ON "payments" USING btree ("folio_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_key" ON "payments" USING btree ("provider","provider_payment_id") WHERE provider_payment_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tax_rules_property_category_key" ON "tax_rules" USING btree ("property_id","category") WHERE active;