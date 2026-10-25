-- Optional admin schema, applied independently of customer API releases.
-- Separate operator identities. Never share customer sessions or auth secrets.
CREATE TABLE admin_auth_user (
 id text PRIMARY KEY,name text NOT NULL,email text NOT NULL UNIQUE,email_verified boolean NOT NULL DEFAULT false,
 image text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 two_factor_enabled boolean NOT NULL DEFAULT false,active boolean NOT NULL DEFAULT true
);
CREATE TABLE admin_auth_session (
 id text PRIMARY KEY,token text NOT NULL UNIQUE,user_id text NOT NULL REFERENCES admin_auth_user(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 ip_address text,user_agent text,mfa_verified_at timestamptz
);
CREATE INDEX admin_auth_session_user_idx ON admin_auth_session(user_id);
CREATE INDEX admin_auth_session_expiry_idx ON admin_auth_session(expires_at);
CREATE TABLE admin_auth_account (
 id text PRIMARY KEY,account_id text NOT NULL,provider_id text NOT NULL,user_id text NOT NULL REFERENCES admin_auth_user(id) ON DELETE CASCADE,
 access_token text,refresh_token text,id_token text,access_token_expires_at timestamptz,refresh_token_expires_at timestamptz,
 scope text,password text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_auth_account_user_idx ON admin_auth_account(user_id);
CREATE TABLE admin_auth_verification (
 id text PRIMARY KEY,identifier text NOT NULL,value text NOT NULL,expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_auth_verification_identifier_idx ON admin_auth_verification(identifier);
CREATE INDEX admin_auth_verification_expiry_idx ON admin_auth_verification(expires_at);
CREATE TABLE admin_auth_two_factor (
 id text PRIMARY KEY,user_id text NOT NULL UNIQUE REFERENCES admin_auth_user(id) ON DELETE CASCADE,
 secret text NOT NULL,backup_codes text NOT NULL,verified boolean NOT NULL DEFAULT false,
 failed_verification_count integer NOT NULL DEFAULT 0,locked_until timestamptz
);
CREATE TABLE admin_auth_throttle(key text PRIMARY KEY,count integer NOT NULL CHECK(count>0),expires_at timestamptz NOT NULL);
CREATE INDEX admin_auth_throttle_expiry_idx ON admin_auth_throttle(expires_at);

CREATE TABLE admin_audit_event(id uuid PRIMARY KEY,operator_id text NOT NULL,action text NOT NULL CHECK(action IN ('overview','users','user')),target_id text,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX admin_audit_event_created_idx ON admin_audit_event(created_at);

-- Explicit projection: no token, OTP, avatar bytes, provider payload or session key.
CREATE VIEW admin_report_users AS
 WITH active_policy AS (
  SELECT p.configuration FROM cloud_policy p JOIN cloud_active_policy a ON a.revision=p.revision
  WHERE a.singleton=true LIMIT 1
 )
 SELECT u.id,u.email,u.name,u.created_at,u.email_verified,u.lifecycle,
 b.status AS subscription_status,b.product_id,b.paid_until,
 -- Stored policy/billing display only: do not infer authorization or issue grants on read.
 coalesce(p.configuration->>'selfHostedPlan',
  CASE WHEN b.status='active' AND b.paid_until>now() THEN product.plan
   ELSE p.configuration->>'freePlan' END,'unknown') AS plan
 FROM auth_user u LEFT JOIN billing_customer b ON b.user_id=u.id
 LEFT JOIN active_policy p ON true
 LEFT JOIN LATERAL (
  SELECT item->>'plan' AS plan FROM jsonb_array_elements(coalesce(p.configuration->'subscriptions','[]'::jsonb)) item
  WHERE item->>'productId'=b.product_id LIMIT 1
 ) product ON true;
CREATE VIEW admin_report_sessions AS SELECT id,user_id,device,created_at,expires_at FROM auth_session;
CREATE VIEW admin_report_wallets AS SELECT user_id,suspended FROM credit_wallet;
CREATE VIEW admin_report_grants AS SELECT user_id,amount,spent,held,revoked,expires_at FROM credit_grant;
CREATE VIEW admin_report_requests AS
 SELECT r.id,r.user_id,r.model_id,r.state,r.error_class AS error_code,r.charged,r.started_at AS created_at,r.dispatched_at,
 CASE WHEN r.state='settled' AND r.cost_rates IS NOT NULL AND r.usage IS NOT NULL
   AND NOT (r.usage ? 'audioMilliseconds') AND c.terminal THEN c.exposure ELSE NULL END AS provider_cost_usd_micros
 FROM cloud_request r LEFT JOIN cloud_cost_record c ON c.request_id=r.id;
CREATE VIEW admin_report_billing AS SELECT
 (SELECT count(*) FROM billing_customer WHERE status='active' AND paid_until>now()) AS active_subscriptions,
 (SELECT count(*) FROM billing_checkout WHERE expires_at>now()) AS open_checkouts,
 ((SELECT count(*) FROM billing_customer WHERE requested>processed)+
  (SELECT count(*) FROM billing_order_job WHERE requested>processed)+
  (SELECT count(*) FROM billing_contact_job WHERE requested>processed)+
  (SELECT count(*) FROM billing_plan_change WHERE state IN ('queued','executing','uncertain'))+
  (SELECT count(*) FROM cloud_outbox WHERE delivered_at IS NULL)) AS pending_jobs;
-- Exposure includes unconfirmed upstream usage; it is not a provider invoice.
CREATE VIEW admin_report_budget AS
 SELECT scope||':day:'||day::text AS key,
 coalesce(sum(exposure) FILTER(WHERE terminal),0) AS spent,
 coalesce(sum(exposure) FILTER(WHERE NOT terminal),0) AS reserved
 FROM cloud_cost_record WHERE day=(now() AT TIME ZONE 'UTC')::date GROUP BY scope,day
 UNION ALL
 SELECT scope||':free:'||day::text AS key,
 coalesce(sum(free_exposure) FILTER(WHERE terminal),0) AS spent,
 coalesce(sum(free_exposure) FILTER(WHERE NOT terminal),0) AS reserved
 FROM cloud_cost_record WHERE day=(now() AT TIME ZONE 'UTC')::date GROUP BY scope,day;
CREATE INDEX admin_users_email_idx ON auth_user(lower(email));
CREATE INDEX admin_users_created_idx ON auth_user(created_at DESC,id DESC);
CREATE INDEX admin_requests_created_idx ON cloud_request(started_at);
CREATE INDEX admin_requests_user_created_idx ON cloud_request(user_id,started_at DESC,id DESC);
CREATE INDEX admin_cost_day_idx ON cloud_cost_record(day);

REVOKE ALL ON admin_auth_user,admin_auth_session,admin_auth_account,admin_auth_verification,admin_auth_two_factor,admin_auth_throttle,admin_audit_event FROM PUBLIC;
REVOKE ALL ON admin_report_users,admin_report_sessions,admin_report_wallets,admin_report_grants,admin_report_requests,admin_report_billing,admin_report_budget FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='zephium_app') THEN
 REVOKE ALL ON admin_auth_user,admin_auth_session,admin_auth_account,admin_auth_verification,admin_auth_two_factor,admin_auth_throttle,admin_audit_event FROM zephium_app;
 REVOKE ALL ON admin_report_users,admin_report_sessions,admin_report_wallets,admin_report_grants,admin_report_requests,admin_report_billing,admin_report_budget FROM zephium_app;
 END IF;
END $$;
