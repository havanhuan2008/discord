-- Migration: Thêm cột is_active và logged_out_at vào bảng devices
-- Mục đích: Thay vì XÓA device khi logout (dẫn đến bug ngày hôm sau máy khác đăng nhập được),
--           ta chỉ đánh dấu is_active = false. Slot vẫn bị giữ mãi cho thiết bị đó.

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS logged_out_at TIMESTAMPTZ;

-- Tất cả device hiện có được coi là đang active
UPDATE devices SET is_active = TRUE WHERE is_active IS NULL;
