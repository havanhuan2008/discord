# Hướng Dẫn Cài Đặt Tính Năng Chat

## Biến Môi Trường Cần Thêm

Thêm các biến này vào file `.env` hoặc Render Environment Variables:

```
# Discord channel ID dành riêng cho chat (admin xem tin nhắn ở đây)
DISCORD_CHAT_CHANNEL_ID=YOUR_DISCORD_CHAT_CHANNEL_ID

# Secret để các API admin call (tự đặt chuỗi bí mật)
ADMIN_SECRET=your_super_secret_key_here
```

## Migration Database

Chạy file SQL sau để tạo bảng chat:

```bash
# Cách 1: Dùng drizzle-kit push (auto)
pnpm run migrate

# Cách 2: Chạy SQL thủ công
psql $DATABASE_URL < drizzle/0005_add_chat_tables.sql
```

## Lệnh Discord Bot

Sau khi bot khởi động, admin có thể dùng:

| Lệnh | Mô tả |
|------|-------|
| `/chatdanhsach` | Xem danh sách phiên chat đang chờ/hoạt động |
| `/chatchapnhan <id>` | Chấp nhận yêu cầu chat của người dùng |
| `/chatra <id> <tin nhắn>` | Trả lời người dùng |
| `/chatguianh <id> <url>` | Gửi ảnh đến người dùng |
| `/chatthoat <id>` | Kết thúc phiên chat |

## Luồng Hoạt Động

1. **Người dùng** nhấn icon chat (💬) trên header app
2. Nếu chưa đăng nhập Google → hiện banner yêu cầu đăng nhập
3. Nếu đã đăng nhập → tạo session chat + bot gửi tin nhắn chờ
4. Thông báo tự động gửi lên kênh Discord (DISCORD_CHAT_CHANNEL_ID)
5. **Admin** dùng `/chatdanhsach` để xem các yêu cầu
6. Admin dùng `/chatchapnhan <id>` → avatar chuyển sang avatar Discord + hiện online
7. Admin trả lời bằng `/chatra <id> <tin nhắn>`
8. Admin gửi ảnh bằng `/chatguianh <id> <url>`
9. Admin kết thúc bằng `/chatthoat <id>`
10. Tin nhắn lưu mãi mãi trong DB

## API Endpoints

```
POST /api/chat/session          — Tạo/lấy session (app gọi)
GET  /api/chat/session?deviceId — Lấy trạng thái session
POST /api/chat/message          — Gửi tin nhắn (app gọi)
GET  /api/chat/messages?sessionId&deviceId&after — Poll tin nhắn

# Admin endpoints (cần header x-admin-secret)
POST /api/chat/admin/accept     — Chấp nhận chat
POST /api/chat/admin/reply      — Admin gửi tin
POST /api/chat/admin/close      — Đóng chat
GET  /api/chat/admin/sessions   — Danh sách session
```
