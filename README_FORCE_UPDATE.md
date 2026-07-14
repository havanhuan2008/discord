# 🔄 Force Update — Hướng dẫn sử dụng

## API — Các lệnh Discord bot mới

### `/update on [phien_ban]`
Bật force update. Tất cả người dùng có versionCode < phien_ban sẽ bị block khi mở app.

```
/update on phien_ban:12
```
→ Bot trả về:
```
🟢 Force Update: ON
• Trạng thái: BẬT — người dùng bắt buộc cập nhật
• VersionCode tối thiểu: 12
• Link tải APK: (chưa đặt)
```

### `/update off`
Tắt force update. Người dùng có thể vào app bình thường.

```
/update off
```

### `/setdownloadurl <url>`
Đặt link tải APK mới hiển thị trên màn hình force update.

```
/setdownloadurl url:https://example.com/app-v12.apk
```

### `/statusupdate`
Xem trạng thái hiện tại (on/off, versionCode, link tải).

---

## API endpoint (cho app gọi)

```
GET /api/app/version-check
```

Response:
```json
{
  "forceUpdate": true,
  "minVersionCode": 12,
  "downloadUrl": "https://example.com/app-v12.apk"
}
```

---

## Migration database

Chạy lệnh sau để tạo bảng `app_config`:

```bash
pnpm run migrate
```

Hoặc thực thi trực tiếp file SQL:
```
drizzle/0007_add_app_config.sql
```

---

## Cách tăng versionCode cho app mới

Mở file `app/build.gradle.kts`, tìm dòng:

```kotlin
versionCode = 10
versionName = "10.0"
```

Thay thành versionCode mới (ví dụ: 12):

```kotlin
versionCode = 12
versionName = "12.0"
```

Sau đó build lại app và distribute APK mới cho người dùng.
