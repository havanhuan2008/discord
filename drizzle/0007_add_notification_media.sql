-- Migration: Thêm image_url + link_url vào bảng notifications
-- Mục đích: Cho phép bot/admin gửi thông báo kèm ảnh minh họa (hiển thị BigPictureStyle
--           trên push notification) và link đính kèm (mở khi bấm vào thông báo).

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS image_url TEXT,
  ADD COLUMN IF NOT EXISTS link_url TEXT;
