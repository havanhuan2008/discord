import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Tài khoản Google đã liên kết với thiết bị/app — độc lập với key kích hoạt.
// Đăng nhập Google là tuỳ chọn, không tự động mở khoá tính năng nào của app.
export const googleAccountsTable = pgTable("google_accounts", {
  id: serial("id").primaryKey(),
  googleId: text("google_id").notNull().unique(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull().default(""),
  avatarUrl: text("avatar_url").notNull().default(""),
  deviceId: text("device_id").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertGoogleAccountSchema = createInsertSchema(googleAccountsTable).omit({
  id: true,
  createdAt: true,
  lastLoginAt: true,
});
export type InsertGoogleAccount = z.infer<typeof insertGoogleAccountSchema>;
export type GoogleAccount = typeof googleAccountsTable.$inferSelect;
