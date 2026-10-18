CREATE TABLE auth_user (
 id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE, email_verified boolean NOT NULL DEFAULT false,
 image text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','deleting'))
);
CREATE TABLE auth_session (
 id text PRIMARY KEY, token text NOT NULL UNIQUE, user_id text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 ip_address text, user_agent text
);
CREATE INDEX session_user_idx ON auth_session(user_id);
CREATE TABLE auth_account (
 id text PRIMARY KEY, account_id text NOT NULL, provider_id text NOT NULL, user_id text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
 access_token text, refresh_token text, id_token text, access_token_expires_at timestamptz, refresh_token_expires_at timestamptz,
 scope text, password text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(provider_id, account_id)
);
CREATE INDEX account_user_idx ON auth_account(user_id);
CREATE TABLE auth_verification (
 id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_identifier_idx ON auth_verification(identifier);
CREATE TABLE abuse_bucket (key text PRIMARY KEY, count integer NOT NULL, expires_at timestamptz NOT NULL);
CREATE INDEX abuse_expiry_idx ON abuse_bucket(expires_at);
CREATE TABLE billing_customer (
 provider_touched boolean NOT NULL DEFAULT false,
 user_id text PRIMARY KEY REFERENCES auth_user(id) ON DELETE CASCADE, polar_id text UNIQUE,
 status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','active','inactive')),
 paid_until timestamptz, cancel_at_period_end boolean NOT NULL DEFAULT false, reconciled_at timestamptz,
 requested integer NOT NULL DEFAULT 1, processed integer NOT NULL DEFAULT 0, attempts integer NOT NULL DEFAULT 0,
 next_attempt timestamptz NOT NULL DEFAULT now(), checkout_until timestamptz
);
CREATE INDEX billing_pending_idx ON billing_customer(next_attempt);
-- Better Auth owns account creation. Keep the associated lifecycle row in the same transaction.
CREATE FUNCTION initialize_billing_customer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO billing_customer(user_id) VALUES (NEW.id);
 RETURN NEW;
END;
$$;
CREATE TRIGGER auth_user_billing AFTER INSERT ON auth_user FOR EACH ROW EXECUTE FUNCTION initialize_billing_customer();
-- Deliberately content-free: verified webhook bodies are not retained.
CREATE TABLE billing_event (id text PRIMARY KEY, digest text NOT NULL, received_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX billing_event_expiry_idx ON billing_event(received_at);
-- Crash-safe provider deletion progress; kept while the account is sealed.
CREATE TABLE account_deletion (
 user_id text PRIMARY KEY REFERENCES auth_user(id) ON DELETE CASCADE, requested_at timestamptz NOT NULL DEFAULT now()
);
