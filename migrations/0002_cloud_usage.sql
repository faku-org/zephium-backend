ALTER TABLE billing_customer ADD COLUMN subscription_id text;
ALTER TABLE billing_customer ADD COLUMN product_id text;
ALTER TABLE billing_customer ADD COLUMN period_start timestamptz;
ALTER TABLE billing_customer ADD COLUMN subscription_start timestamptz;
CREATE TABLE cloud_policy(revision integer PRIMARY KEY, digest text NOT NULL, configuration jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE cloud_active_policy(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), revision integer NOT NULL REFERENCES cloud_policy(revision));
CREATE TABLE credit_wallet(user_id text PRIMARY KEY REFERENCES auth_user(id) ON DELETE CASCADE, anchor timestamptz NOT NULL DEFAULT now(), welcomed_at timestamptz, daily_limit_units bigint CHECK(daily_limit_units>=0), suspended boolean NOT NULL DEFAULT false);
CREATE TABLE credit_grant(
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES credit_wallet(user_id) ON DELETE CASCADE,
 grant_key text NOT NULL, kind text NOT NULL CHECK(kind IN ('welcome','included','topup')), policy_revision integer NOT NULL REFERENCES cloud_policy(revision), plan_id text,
 amount bigint NOT NULL CHECK(amount>=0), spent bigint NOT NULL DEFAULT 0 CHECK(spent>=0), held bigint NOT NULL DEFAULT 0 CHECK(held>=0),
 revoked boolean NOT NULL DEFAULT false, period_start timestamptz, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,grant_key), CHECK(spent+held<=amount)
);
CREATE INDEX credit_grant_owner ON credit_grant(user_id,expires_at);
CREATE TABLE cloud_request(
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES credit_wallet(user_id) ON DELETE CASCADE, session_id text NOT NULL,
 client_key text NOT NULL, provider text NOT NULL, model_id text NOT NULL, route text NOT NULL,
 policy_revision integer NOT NULL REFERENCES cloud_policy(revision), price_snapshot jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('preflight','reserved','running','usage_unknown','settled','released')),
 reserved bigint NOT NULL DEFAULT 0 CHECK(reserved>=0), charged bigint NOT NULL DEFAULT 0 CHECK(charged>=0), actual_cost bigint, usage jsonb,
 error_class text, upstream_request_id text, upstream_status integer,
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, lease_until timestamptz NOT NULL, hold_until timestamptz NOT NULL,
 UNIQUE(user_id,client_key)
);
CREATE INDEX cloud_request_live ON cloud_request(user_id,state,lease_until);
CREATE INDEX cloud_request_recovery ON cloud_request(state,hold_until);
CREATE TABLE credit_allocation(request_id uuid NOT NULL REFERENCES cloud_request(id) ON DELETE CASCADE,grant_id uuid NOT NULL REFERENCES credit_grant(id) ON DELETE CASCADE,amount bigint NOT NULL CHECK(amount>0),PRIMARY KEY(request_id,grant_id));
CREATE TABLE provider_bucket(provider text PRIMARY KEY, requests double precision NOT NULL, tokens double precision NOT NULL, updated_at timestamptz NOT NULL);
CREATE TABLE cloud_outbox(request_id uuid PRIMARY KEY REFERENCES cloud_request(id) ON DELETE CASCADE, payload jsonb NOT NULL, attempts integer NOT NULL DEFAULT 0, next_attempt timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz);
CREATE INDEX cloud_outbox_pending ON cloud_outbox(next_attempt) WHERE delivered_at IS NULL;
CREATE TABLE billing_order_job(order_id text PRIMARY KEY,user_id text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,requested integer NOT NULL DEFAULT 1,processed integer NOT NULL DEFAULT 0,attempts integer NOT NULL DEFAULT 0,next_attempt timestamptz NOT NULL DEFAULT now());
