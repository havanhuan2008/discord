-- Migration: tạo bảng google_accounts (đăng nhập Google, tách biệt với key kích hoạt)
CREATE TABLE IF NOT EXISTS "google_accounts" (
  "id" serial PRIMARY KEY,
  "google_id" text NOT NULL UNIQUE,
  "email" text NOT NULL,
  "display_name" text NOT NULL DEFAULT '',
  "avatar_url" text NOT NULL DEFAULT '',
  "device_id" text NOT NULL DEFAULT '',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_login_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_google_accounts_device" ON "google_accounts"("device_id");
