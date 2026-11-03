CREATE TYPE "public"."audit_actor_type" AS ENUM('consumer_app', 'admin', 'system');--> statement-breakpoint
CREATE TYPE "public"."jwt_algo" AS ENUM('RS256');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('whatsapp', 'instagram');--> statement-breakpoint
CREATE TYPE "public"."consumer_app_status" AS ENUM('active', 'deactivated');--> statement-breakpoint
CREATE TYPE "public"."webhook_delivery_status" AS ENUM('pending', 'delivered', 'failed', 'dead_letter');--> statement-breakpoint
CREATE TYPE "public"."outbound_job_status" AS ENUM('queued', 'sending', 'sent', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."webhook_subscription_status" AS ENUM('active', 'paused', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."template_category" AS ENUM('UTILITY', 'MARKETING', 'AUTHENTICATION');--> statement-breakpoint
CREATE TYPE "public"."template_meta_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('active', 'disabled', 'deleted');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"tenant_id" uuid,
	"app_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload_redacted" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "ig_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"meta_ig_id" text NOT NULL,
	"username" text NOT NULL,
	"account_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ig_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ig_connection_id" uuid NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"dek_ciphertext" "bytea" NOT NULL,
	"dek_key_id" text NOT NULL,
	"encryption_context" jsonb NOT NULL,
	"algo" text NOT NULL,
	"nonce" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"refresh_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "phone_numbers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"waba_connection_id" uuid NOT NULL,
	"meta_phone_id" text NOT NULL,
	"display_phone_number" text NOT NULL,
	"quality_rating" text,
	"messaging_limit_tier" text,
	"verified_name" text,
	"messaging_limit_daily_max" integer,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waba_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"meta_business_id" text NOT NULL,
	"meta_waba_id" text NOT NULL,
	"display_name" text,
	"verified_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "waba_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"waba_connection_id" uuid NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"dek_ciphertext" "bytea" NOT NULL,
	"dek_key_id" text NOT NULL,
	"encryption_context" jsonb NOT NULL,
	"algo" text NOT NULL,
	"nonce" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"refresh_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"app_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_records_app_id_key_pk" PRIMARY KEY("app_id","key")
);
--> statement-breakpoint
CREATE TABLE "admin_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"mfa_enrolled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"app_id" uuid NOT NULL,
	"public_key_pem" text NOT NULL,
	"algo" "jwt_algo" DEFAULT 'RS256' NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone,
	"rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consumer_apps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "consumer_app_status" DEFAULT 'active' NOT NULL,
	"current_public_key_pem" text,
	"current_public_key_id" uuid,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"app_id" uuid NOT NULL,
	"external_id" text,
	"display_name" text NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "tenant_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"waba_connection_id" uuid NOT NULL,
	"name" text NOT NULL,
	"language" text NOT NULL,
	"category" "template_category" NOT NULL,
	"components_json" jsonb NOT NULL,
	"meta_status" "template_meta_status" NOT NULL,
	"meta_quality_score" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"app_id" uuid,
	"event_type" text NOT NULL,
	"meta_event_id" text,
	"payload_json" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "outbound_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"channel" "channel" NOT NULL,
	"payload_json" jsonb NOT NULL,
	"status" "outbound_job_status" DEFAULT 'queued' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"last_error" text,
	"provider_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subscription_id" uuid NOT NULL,
	"inbound_event_id" uuid NOT NULL,
	"status" "webhook_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_response_status" integer,
	"last_error" text,
	"next_retry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"app_id" uuid NOT NULL,
	"tenant_id" uuid,
	"url" text NOT NULL,
	"secret_ciphertext" "bytea" NOT NULL,
	"secret_dek_ciphertext" "bytea" NOT NULL,
	"secret_dek_key_id" text NOT NULL,
	"secret_encryption_context" jsonb NOT NULL,
	"secret_algo" text NOT NULL,
	"secret_nonce" "bytea" NOT NULL,
	"secret_auth_tag" "bytea" NOT NULL,
	"event_types_filter" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "webhook_subscription_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_app_id_consumer_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."consumer_apps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ig_connections" ADD CONSTRAINT "ig_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ig_connections" ADD CONSTRAINT "ig_connections_app_id_consumer_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."consumer_apps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ig_tokens" ADD CONSTRAINT "ig_tokens_ig_connection_id_ig_connections_id_fk" FOREIGN KEY ("ig_connection_id") REFERENCES "public"."ig_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_waba_connection_id_waba_connections_id_fk" FOREIGN KEY ("waba_connection_id") REFERENCES "public"."waba_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waba_connections" ADD CONSTRAINT "waba_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waba_connections" ADD CONSTRAINT "waba_connections_app_id_consumer_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."consumer_apps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waba_tokens" ADD CONSTRAINT "waba_tokens_waba_connection_id_waba_connections_id_fk" FOREIGN KEY ("waba_connection_id") REFERENCES "public"."waba_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_app_id_consumer_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."consumer_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_keys" ADD CONSTRAINT "app_keys_app_id_consumer_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."consumer_apps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_app_id_consumer_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."consumer_apps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_waba_connection_id_waba_connections_id_fk" FOREIGN KEY ("waba_connection_id") REFERENCES "public"."waba_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_app_id_consumer_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."consumer_apps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_jobs" ADD CONSTRAINT "outbound_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_jobs" ADD CONSTRAINT "outbound_jobs_app_id_consumer_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."consumer_apps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_webhook_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."webhook_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_inbound_event_id_inbound_events_id_fk" FOREIGN KEY ("inbound_event_id") REFERENCES "public"."inbound_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_app_id_consumer_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."consumer_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_occurred_at_idx" ON "audit_logs" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_type","actor_id");--> statement-breakpoint
CREATE INDEX "audit_logs_resource_idx" ON "audit_logs" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_idx" ON "audit_logs" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ig_connections_tenant_ig_uniq" ON "ig_connections" USING btree ("tenant_id","meta_ig_id");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_numbers_meta_phone_id_uniq" ON "phone_numbers" USING btree ("meta_phone_id");--> statement-breakpoint
CREATE UNIQUE INDEX "waba_connections_tenant_waba_uniq" ON "waba_connections" USING btree ("tenant_id","meta_waba_id");--> statement-breakpoint
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_accounts_email_uniq" ON "admin_accounts" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "app_keys_app_id_id_uniq" ON "app_keys" USING btree ("app_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_app_external_id_uniq" ON "tenants" USING btree ("app_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "templates_waba_name_lang_uniq" ON "templates" USING btree ("waba_connection_id","name","language");--> statement-breakpoint
CREATE INDEX "inbound_events_meta_event_id_idx" ON "inbound_events" USING btree ("meta_event_id");--> statement-breakpoint
CREATE INDEX "inbound_events_received_at_idx" ON "inbound_events" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_jobs_app_idempotency_uniq" ON "outbound_jobs" USING btree ("app_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "outbound_jobs_status_created_idx" ON "outbound_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "outbound_jobs_tenant_created_idx" ON "outbound_jobs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_retry_idx" ON "webhook_deliveries" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_subscription_status_idx" ON "webhook_deliveries" USING btree ("subscription_id","status");--> statement-breakpoint
CREATE INDEX "webhook_subscriptions_app_status_idx" ON "webhook_subscriptions" USING btree ("app_id","status");