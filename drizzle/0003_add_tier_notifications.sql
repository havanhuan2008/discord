-- Migration: thêm cột tier vào bảng keys
ALTER TABLE "keys" ADD COLUMN IF NOT EXISTS "tier" text NOT NULL DEFAULT 'free';

-- Migration: tạo bảng notifications
CREATE TABLE IF NOT EXISTS "notifications" (
  "id" serial PRIMARY KEY,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "sent_by" text NOT NULL DEFAULT 'admin',
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Migration: tạo bảng notification_reads
CREATE TABLE IF NOT EXISTS "notification_reads" (
  "id" serial PRIMARY KEY,
  "notification_id" integer NOT NULL,
  "device_id" text NOT NULL,
  "read_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Unique constraint để tránh duplicate đọc (race-condition trên heartbeat song song)
CREATE UNIQUE INDEX IF NOT EXISTS "idx_notif_reads_unique" ON "notification_reads"("notification_id", "device_id");
CREATE INDEX IF NOT EXISTS "idx_notif_reads_device" ON "notification_reads"("device_id");
