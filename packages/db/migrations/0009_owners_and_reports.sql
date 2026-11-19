CREATE TABLE "owner_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"model" text DEFAULT 'revenue_share' NOT NULL,
	"management_fee_bp" integer DEFAULT 2000 NOT NULL,
	"fee_basis" text DEFAULT 'net' NOT NULL,
	"fee_tax_bp" integer DEFAULT 1800 NOT NULL,
	"commission_on_owner" boolean DEFAULT true NOT NULL,
	"fixed_rent" bigint,
	"owner_nights_per_year" integer,
	"owner_stay_notice_days" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_contracts_model_check" CHECK (model IN ('revenue_share','fixed_rent')),
	CONSTRAINT "owner_contracts_basis_check" CHECK (fee_basis IN ('gross','net')),
	CONSTRAINT "owner_contracts_dates_check" CHECK (ends_on IS NULL OR ends_on >= starts_on),
	CONSTRAINT "owner_contracts_rates_check" CHECK (management_fee_bp BETWEEN 0 AND 10000 AND fee_tax_bp BETWEEN 0 AND 10000),
	CONSTRAINT "owner_contracts_rent_check" CHECK ((model = 'fixed_rent') = (fixed_rent IS NOT NULL) AND (fixed_rent IS NULL OR fixed_rent >= 0)),
	CONSTRAINT "owner_contracts_stay_check" CHECK ((owner_nights_per_year IS NULL OR owner_nights_per_year >= 0) AND owner_stay_notice_days >= 0)
);
--> statement-breakpoint
CREATE TABLE "owner_expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"date" date NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"description" text NOT NULL,
	"amount" bigint NOT NULL,
	"maintenance_issue_id" uuid,
	"statement_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_expenses_category_check" CHECK (category IN ('maintenance','utilities','supplies','cleaning','other')),
	CONSTRAINT "owner_expenses_amount_check" CHECK (amount > 0)
);
--> statement-breakpoint
CREATE TABLE "owner_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"number" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency" text NOT NULL,
	"room_nights" integer DEFAULT 0 NOT NULL,
	"gross_revenue" bigint DEFAULT 0 NOT NULL,
	"channel_commission" bigint DEFAULT 0 NOT NULL,
	"management_fee" bigint DEFAULT 0 NOT NULL,
	"fee_tax" bigint DEFAULT 0 NOT NULL,
	"expenses" bigint DEFAULT 0 NOT NULL,
	"adjustments" bigint DEFAULT 0 NOT NULL,
	"payout" bigint DEFAULT 0 NOT NULL,
	"lines" jsonb NOT NULL,
	"notes" text,
	"issued_at" timestamp with time zone,
	"issued_by" uuid,
	"paid_at" timestamp with time zone,
	"payment_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_statements_status_check" CHECK (status IN ('draft','issued','paid')),
	CONSTRAINT "owner_statements_period_check" CHECK (period_end > period_start)
);
--> statement-breakpoint
CREATE TABLE "owners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"email" "citext",
	"phone" text,
	"address_line1" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"country" text DEFAULT 'IN' NOT NULL,
	"gstin" text,
	"user_id" uuid,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"report" text NOT NULL,
	"group_by" text,
	"property_ids" jsonb,
	"period" text NOT NULL,
	"frequency" text NOT NULL,
	"weekday" integer,
	"day_of_month" integer,
	"hour" integer DEFAULT 7 NOT NULL,
	"recipients" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_schedules_report_check" CHECK (report IN ('performance','channel_mix','pace','revenue','agent_commission')),
	CONSTRAINT "report_schedules_period_check" CHECK (period IN ('yesterday','last_7_days','last_30_days','month_to_date','last_month','next_30_days','next_90_days')),
	CONSTRAINT "report_schedules_frequency_check" CHECK (frequency IN ('daily','weekly','monthly')),
	CONSTRAINT "report_schedules_when_check" CHECK (hour BETWEEN 0 AND 23 AND (weekday IS NULL OR weekday BETWEEN 0 AND 6) AND (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 28))
);
--> statement-breakpoint
ALTER TABLE "owner_contracts" ADD CONSTRAINT "owner_contracts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_contracts" ADD CONSTRAINT "owner_contracts_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_contracts" ADD CONSTRAINT "owner_contracts_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_contracts" ADD CONSTRAINT "owner_contracts_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_expenses" ADD CONSTRAINT "owner_expenses_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_expenses" ADD CONSTRAINT "owner_expenses_contract_id_owner_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."owner_contracts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_expenses" ADD CONSTRAINT "owner_expenses_maintenance_issue_id_maintenance_issues_id_fk" FOREIGN KEY ("maintenance_issue_id") REFERENCES "public"."maintenance_issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_expenses" ADD CONSTRAINT "owner_expenses_statement_id_owner_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."owner_statements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_expenses" ADD CONSTRAINT "owner_expenses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_statements" ADD CONSTRAINT "owner_statements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_statements" ADD CONSTRAINT "owner_statements_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_statements" ADD CONSTRAINT "owner_statements_contract_id_owner_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."owner_contracts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_statements" ADD CONSTRAINT "owner_statements_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_statements" ADD CONSTRAINT "owner_statements_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owners" ADD CONSTRAINT "owners_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owners" ADD CONSTRAINT "owners_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "owner_contracts_owner_idx" ON "owner_contracts" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "owner_contracts_property_idx" ON "owner_contracts" USING btree ("property_id","unit_id");--> statement-breakpoint
CREATE INDEX "owner_expenses_contract_idx" ON "owner_expenses" USING btree ("contract_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "owner_statements_period_key" ON "owner_statements" USING btree ("contract_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "owner_statements_number_key" ON "owner_statements" USING btree ("org_id","number") WHERE number IS NOT NULL;--> statement-breakpoint
CREATE INDEX "owner_statements_owner_idx" ON "owner_statements" USING btree ("owner_id","period_start");--> statement-breakpoint
CREATE INDEX "owners_org_name_idx" ON "owners" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "owners_user_key" ON "owners" USING btree ("user_id") WHERE user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "report_schedules_due_idx" ON "report_schedules" USING btree ("next_run_at") WHERE active;--> statement-breakpoint
CREATE INDEX "report_schedules_org_idx" ON "report_schedules" USING btree ("org_id");--> statement-breakpoint
-- A unit (or a whole property) is under one contract at a time. A contract for the whole
-- property against one for a single unit of it is checked by the application.
ALTER TABLE "owner_contracts" ADD CONSTRAINT "owner_contracts_no_overlap"
  EXCLUDE USING gist (
    "property_id" WITH =,
    (coalesce("unit_id", '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    daterange("starts_on", "ends_on", '[]') WITH &&
  );
