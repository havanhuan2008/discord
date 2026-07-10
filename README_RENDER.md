# Aujunpeak API — Hướng dẫn deploy lên Render

## Các lệnh bot Discord (đã cải tiến)

**Quản lý key:**
- `/taokey` — tạo key mới; có thêm tùy chọn `key` để **tự đặt nội dung key** (bỏ trống để bot tự sinh ngẫu nhiên)
- `/suakey` — sửa nhãn / ghi chú / số thiết bị tối đa của key đã tạo
- `/danhsachkey` — xem **toàn bộ key**, có **phân trang bằng nút bấm** (không còn giới hạn 20 key — hiển thị hết, 20 key/trang), kèm bộ lọc theo trạng thái/loại (đang hoạt động, đã khóa, hết hạn, VIP, FREE)
- `/xemkey`, `/khoakey`, `/mokey`, `/xoakey`, `/giahan`, `/nangcap` — như cũ
- `/thietbi`, `/xoathietbi`, `/online`, `/thongke` — như cũ

**Quản lý thông báo:**
- `/thongbao` — gửi thông báo đến tất cả người dùng (như cũ)
- `/danhsachthongbao` — xem **toàn bộ thông báo đã gửi**, có phân trang bằng nút bấm, hiển thị ID để dùng khi xóa
- `/xoathongbao <id>` — xóa một thông báo theo ID
- `/xoatatthongbao` — xóa toàn bộ thông báo cùng lúc

**API admin mới (dùng header `x-admin-secret`):**
- `GET /api/admin/keys` — không truyền `page`/`pageSize` sẽ trả về TOÀN BỘ key; truyền cả hai để phân trang
- `POST /api/admin/keys` — hỗ trợ trường `key` để tạo key tùy chỉnh (validate trùng lặp)
- `PATCH /api/admin/keys/:id` — sửa `label`/`note`/`maxDevices`
- `GET /api/admin/notifications` — danh sách thông báo (hỗ trợ phân trang giống trên)
- `DELETE /api/admin/notifications/:id` — xóa 1 thông báo
- `DELETE /api/admin/notifications` — xóa toàn bộ thông báo


## Yêu cầu
- Tài khoản Render.com (miễn phí)
- Database PostgreSQL (Render cung cấp miễn phí)
- Discord Bot đã tạo sẵn
- Link4m API token (đã tích hợp sẵn: `69b825a52226d2546845d241`)

---

## Bước 1 — Tạo PostgreSQL trên Render

1. Vào https://render.com → **New** → **PostgreSQL**
2. Đặt tên: `aujunpeak-db`
3. Plan: **Free**
4. Nhấn **Create Database**
5. Sau khi tạo xong, copy **Internal Database URL** (dùng cho bước 3)

---

## Bước 2 — Upload code lên GitHub

1. Tạo repo mới trên GitHub (private)
2. Upload toàn bộ thư mục `aujunpeak-api/` này lên repo

---

## Bước 3 — Tạo Web Service trên Render

1. Vào Render → **New** → **Web Service**
2. Kết nối với GitHub repo vừa tạo
3. Cấu hình:
   - **Name**: `aujunpeak-api`
   - **Runtime**: `Node`
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm run start`
   - **Plan**: Free

4. Mở tab **Environment** → thêm các biến:

   | Key | Value |
   |-----|-------|
   | `DATABASE_URL` | Internal Database URL từ bước 1 |
   | `DISCORD_BOT_TOKEN` | Token bot Discord |
   | `DISCORD_GUILD_ID` | ID server Discord |
   | `ADMIN_SECRET_KEY` | Chuỗi secret tự đặt (VD: `MyS3cr3tKey2024`) |
   | `LINK4M_API_TOKEN` | Token API Link4m — mặc định `69b825a52226d2546845d241` |
   | `API_BASE_URL` | URL deploy của API (VD: `https://aujunpeak-api.onrender.com`) |
   | `NODE_ENV` | `production` |

5. Nhấn **Create Web Service** → đợi build xong (~2-3 phút)

---

## Bước 4 — Tạo bảng database (chạy 1 lần)

Sau khi deploy xong, vào Render Dashboard → Web Service → **Shell** tab:

```bash
npm run migrate
```

Lệnh này tạo bảng `keys` và `devices` trong PostgreSQL.

---

## Bước 5 — Cập nhật URL trong Android app

Mở `KeyManager.kt` trong Android project, tìm dòng:
```kotlin
private const val API_BASE_URL = "https://..."
```

Thay bằng URL Render của bạn:
```kotlin
private const val API_BASE_URL = "https://aujunpeak-api.onrender.com/api"
```

---

## Kiểm tra hoạt động

```bash
# Health check
curl https://aujunpeak-api.onrender.com/api/healthz

# Tạo key test (thay YOUR_SECRET)
curl -X POST https://aujunpeak-api.onrender.com/api/admin/keys/create \
  -H "x-admin-secret: YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"days": 30, "label": "Test", "maxDevices": 2}'
```

---

## Lưu ý Render Free Plan

- Server sẽ **ngủ sau 15 phút** không có request (spin down)
- Lần đầu gọi API có thể mất 30-60 giây (cold start)
- **Giải pháp**: Dùng UptimeRobot.com (miễn phí) ping `/api/healthz` mỗi 10 phút để giữ server luôn online

## Cấu trúc thư mục

```
aujunpeak-api/
├── src/
│   ├── index.ts          ← Entrypoint
│   ├── app.ts            ← Express setup
│   ├── db/               ← Database (Drizzle ORM)
│   │   ├── index.ts
│   │   └── schema/
│   ├── lib/
│   │   ├── discord-bot.ts ← Discord bot + 11 slash commands
│   │   └── logger.ts
│   └── routes/
│       ├── keys.ts       ← API endpoints
│       └── health.ts
├── build.mjs             ← esbuild bundler
├── drizzle.config.ts     ← DB migration config
├── package.json
└── tsconfig.json
```
