import { pgTable, text, serial, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { keysTable } from "./keys.js";

export const devicesTable = pgTable("devices", {
  id:         serial("id").primaryKey(),
  keyId:      serial("key_id").references(() => keysTable.id, { onDelete: "cascade" }),
  deviceId:   text("device_id").notNull(),
  deviceName: text("device_name").notNull().default("Unknown Device"),
  deviceOs:   text("device_os").notNull().default(""),
  deviceSdk:  integer("device_sdk").notNull().default(0),
  deviceRam:  text("device_ram").notNull().default(""),
  lastSeen:   timestamp("last_seen",   { withTimezone: true }).notNull().defaultNow(),
  createdAt:  timestamp("created_at",  { withTimezone: true }).notNull().defaultNow(),
  // is_active: false = đã logout (slot vẫn bị giữ), true = đang đăng nhập
  // KHÔNG xóa record khi logout — thiết bị đã chiếm slot thì giữ slot mãi
  isActive:   boolean("is_active").notNull().default(true),
  loggedOutAt: timestamp("logged_out_at", { withTimezone: true }),
});

export const insertDeviceSchema = createInsertSchema(devicesTable).omit({ id: true, createdAt: true });
export type InsertDevice = z.infer<typeof insertDeviceSchema>;
export type Device = typeof devicesTable.$inferSelect;
