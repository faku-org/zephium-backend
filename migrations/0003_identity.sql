-- Keep email eligibility accounting after account deletion without retaining an address.
CREATE TABLE email_eligibility (
 key text PRIMARY KEY,
 welcome_claimed_at timestamptz,
 free_anchor timestamptz,
 free_period_end timestamptz
);
ALTER TABLE auth_user ADD COLUMN eligibility_key text REFERENCES email_eligibility(key);
ALTER TABLE auth_session ADD COLUMN device text;

-- Purpose, owner, and destination are separate boundaries. No plaintext email or code is stored.
CREATE TABLE action_otp (
 owner_user_id text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
 purpose text NOT NULL CHECK (purpose IN ('deletion','email-change')),
 destination_key text NOT NULL,
 otp_hash text NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_user_id,purpose,destination_key)
);
CREATE INDEX action_otp_expiry_idx ON action_otp(expires_at);
