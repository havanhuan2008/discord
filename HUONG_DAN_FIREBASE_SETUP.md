# 🔔 Hướng dẫn cài đặt Firebase Push Notification

## ✅ Những gì đã được sửa

### Server (aujunpeak-api-improved)
| # | Thay đổi |
|---|----------|
| 1 | Nâng cấp FCM Legacy API (deprecated) → **FCM HTTP v1 API** mới |
| 2 | Thêm `src/lib/fcm.ts` — helper gửi push, tự động xóa token hết hạn |
| 3 | Bot `/thongbaodaybp` hiển thị lỗi rõ ràng nếu chưa cấu hình Firebase |
| 4 | Không cần cài thêm npm package — dùng Web Crypto API có sẵn trong Node.js |

### App Android (AujunpeakApp_fixed.zip)
| # | Lỗi | Đã sửa |
|---|-----|--------|
| 1 | Plugin `google-services` chưa bật trong Gradle | ✅ |
| 2 | SharedPreferences sai tên (`app_prefs` → `aujunpeak_key_prefs`) | ✅ |
| 3 | Sai key (`device_key` → `activation_key`) | ✅ |
| 4 | Notification channel không được tạo (Android 8+) | ✅ |
| 5 | Thiếu xin quyền POST_NOTIFICATIONS (Android 13+) | ✅ |
| 6 | Token không đăng ký lại sau khi user đăng nhập | ✅ |

---

## ⚠️ BẮT BUỘC: 2 bước cần làm thủ công

### BƯỚC 1 — Tạo Firebase Project & lấy google-services.json (cho App)

1. Truy cập **[Firebase Console](https://console.firebase.google.com/)**
2. Nhấn **"Add project"** → đặt tên (vd: `aujunpeak-app`) → tạo
3. Trong Project Overview → nhấn biểu tượng **Android (</> hoặc 🤖)**
4. Package name: **`com.aujunpeak.app`** → nhấn **Register app**
5. Tải file **`google-services.json`** → đặt vào:
   ```
   AujunpeakApp/
   └── app/
       └── google-services.json   ← ĐẶT VÀO ĐÂY
   ```
6. Mở Android Studio → **File → Sync Project with Gradle Files**

---

### BƯỚC 2 — Lấy Service Account JSON (cho Server)

1. Trong Firebase Console → ⚙️ **Project settings** (bánh răng trên cùng)
2. Tab **Service accounts**
3. Nhấn **"Generate new private key"** → tải file JSON về
4. Mở file JSON ra, **copy toàn bộ nội dung**
5. Trên server (Render.com hoặc nơi deploy):
   - Thêm biến môi trường: `FIREBASE_SERVICE_ACCOUNT_JSON` = *toàn bộ nội dung JSON*
   - (Không cần `FCM_SERVER_KEY` nữa — đã thay bằng Service Account)

---

## 🔄 Luồng hoạt động sau khi cài đặt đúng

```
User cài app → đăng nhập key
    ↓
App lấy FCM token từ Firebase SDK
    ↓
App gọi POST /api/devices/register-fcm { fcmToken, deviceKey, deviceId }
    ↓
Server lưu token vào DB (bảng fcm_tokens)
    ↓
Bot Discord: /thongbaodaybp [tiêu đề] [nội dung]
    ↓
Server đọc tất cả token từ DB
    ↓
Gọi FCM v1 API → thiết bị nhận notification kể cả khi app đóng
```

---

## 🧪 Kiểm tra hoạt động

1. Build và cài app lên điện thoại
2. Đăng nhập bằng key trong app
3. Trong Discord: `/thongbaodaybp tieude:Test noidung:Xin chào`
4. Bot phải báo: `✅ Gửi thành công: 1` (hoặc số thiết bị của bạn)
5. Điện thoại nhận notification ngay cả khi app bị tắt

## ❓ Nếu vẫn báo "Chưa có thiết bị nào"

- Kiểm tra `google-services.json` đã đặt đúng thư mục `app/` chưa
- Kiểm tra `FIREBASE_SERVICE_ACCOUNT_JSON` đã được set trên server chưa
- Xem Logcat trong Android Studio, filter tag `FCM` để debug
