CREATE TABLE account_avatar (
  user_id text PRIMARY KEY REFERENCES auth_user(id) ON DELETE CASCADE,
  version uuid NOT NULL UNIQUE,
  content bytea NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 262144),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  width integer NOT NULL DEFAULT 256 CHECK (width = 256),
  height integer NOT NULL DEFAULT 256 CHECK (height = 256),
  updated_at timestamptz NOT NULL DEFAULT now()
);
