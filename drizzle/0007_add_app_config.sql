CREATE TABLE IF NOT EXISTS "app_config" (
  "id" serial PRIMARY KEY NOT NULL,
  "key" text NOT NULL UNIQUE,
  "value" text NOT NULL DEFAULT '',
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Seed default config values
INSERT INTO "app_config" ("key", "value") VALUES
  ('force_update_enabled', 'false'),
  ('min_version_code', '10'),
  ('download_url', '')
ON CONFLICT ("key") DO NOTHING;
