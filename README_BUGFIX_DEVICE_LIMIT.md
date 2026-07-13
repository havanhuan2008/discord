# 🐛 Bugfix: Key giới hạn 1 thiết bị nhưng ngày hôm sau máy khác vẫn đăng nhập được

## Nguyên nhân gốc rễ

### Bug chính: Logout xóa hoàn toàn device record

Trong code cũ, endpoint `/keys/logout` thực hiện **xóa cứng** (hard delete) record device khỏi database:

```ts
// ❌ CODE CŨ — BUG
await db.delete(devicesTable)
  .where(and(eq(devicesTable.keyId, record.id), eq(devicesTable.deviceId, deviceId)));
```

Khi user đăng xuất (hoặc app bị kill và tự gọi logout), slot thiết bị trở nên **trống hoàn toàn**. Ngày hôm sau, máy B có thể đăng nhập và chiếm slot đó.

### Bug phụ: sameHardware check quá lỏng

Logic kiểm tra "cùng thiết bị cài lại" chỉ so sánh 3 trường (deviceName + OS + SDK), không so sánh RAM. Hai điện thoại cùng model nhưng dung lượng RAM khác nhau vẫn bị coi là "cùng thiết bị".

---

## Cách sửa (FIX đã áp dụng)

### 1. Soft Delete thay vì Hard Delete

```ts
// ✅ CODE MỚI — ĐÃ SỬA
// Logout: đánh dấu is_active=false, KHÔNG xóa record
await db.update(devicesTable)
  .set({ isActive: false, loggedOutAt: new Date() })
  .where(and(eq(devicesTable.keyId, record.id), eq(devicesTable.deviceId, deviceId)));
```

**Nguyên tắc**: Một thiết bị đã chiếm slot thì **giữ slot đó mãi mãi** (dù có logout). Chỉ admin mới có thể giải phóng slot thủ công.

### 2. Validate chặt hơn

```ts
// Lấy TẤT CẢ devices (kể cả đã logout is_active=false)
const existingDevices = await db.select().from(devicesTable)...

// Nếu slot đầy → chặn dù thiết bị gốc đã logout
if (existingDevices.length >= record.maxDevices) {
  // Chỉ cho qua nếu đúng là cùng thiết bị vật lý (sameHardware + RAM khớp)
  // Nếu là máy khác → block
}
```

### 3. sameHardware check thắt chặt hơn

```ts
// ✅ CODE MỚI: yêu cầu khớp đủ 4 trường (thêm RAM)
const sameHardware = existingDevices.find(d =>
  d.deviceName === deviceName &&
  d.deviceOs   === deviceOs &&
  Number(d.deviceSdk) === Number(deviceSdk) &&
  d.deviceRam  === deviceRam  // ← THÊM MỚI
);
```

### 4. Thiết bị đã logout vẫn đăng nhập lại được bình thường

Nếu user đăng xuất máy A rồi muốn đăng nhập lại máy A → vẫn được, vì `deviceId` khớp:

```ts
// thisDevice tồn tại (dù is_active=false) → cho đăng nhập lại, set is_active=true
if (thisDevice) {
  await db.update(devicesTable)
    .set({ isActive: true, loggedOutAt: null, lastSeen: new Date(), ... })
    ...
}
```

---

## Migration Database cần chạy

Chạy file migration sau trên database production:

```sql
-- File: drizzle/0006_device_soft_delete.sql
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS logged_out_at TIMESTAMPTZ;

UPDATE devices SET is_active = TRUE WHERE is_active IS NULL;
```

Hoặc dùng Drizzle:
```bash
npx drizzle-kit push
```

---

## Admin API mới

### Xóa TẤT CẢ devices của một key (giải phóng toàn bộ slot)
```
DELETE /admin/keys/:id/devices
Headers: x-admin-secret: <ADMIN_SECRET_KEY>
```

### Xóa một device cụ thể (giải phóng 1 slot)
```
DELETE /admin/keys/:id/devices/:deviceId
Headers: x-admin-secret: <ADMIN_SECRET_KEY>
```

---

## Tóm tắt hành vi sau khi fix

| Tình huống | Trước fix | Sau fix |
|------------|-----------|---------|
| Máy A đăng nhập key (maxDevices=1) | ✅ Được | ✅ Được |
| Máy B đăng nhập key đó (A vẫn dùng) | ❌ Bị block | ❌ Bị block |
| Máy A logout, máy B đăng nhập | ✅ Được (BUG!) | ❌ Bị block ✅ |
| Máy A logout, máy A đăng nhập lại | ✅ Được | ✅ Được |
| Máy A uninstall/reinstall (cùng phần cứng) | ✅ Được | ✅ Được |
| Máy B giả mạo phần cứng máy A | ✅ Được (BUG!) | ❌ Bị block (RAM check) ✅ |
| Admin xóa slot → máy B đăng nhập | N/A | ✅ Được |
