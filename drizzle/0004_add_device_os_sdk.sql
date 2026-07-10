-- Migration: thêm cột deviceOs, deviceSdk, deviceRam vào bảng devices
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "device_os"  text    NOT NULL DEFAULT '';
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "device_sdk" integer NOT NULL DEFAULT 0;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "device_ram" text    NOT NULL DEFAULT '';
