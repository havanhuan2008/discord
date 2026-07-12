import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const fcmTokensTable = pgTable("fcm_tokens", {
  id:        serial("id").primaryKey(),
  fcmToken:  text("fcm_token").notNull().unique(),
  deviceKey: text("device_key"),
  deviceId:  text("device_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertFcmTokenSchema = createInsertSchema(fcmTokensTable)
  .omit({ id: true, createdAt: true });
export type InsertFcmToken = z.infer<typeof insertFcmTokenSchema>;
export type FcmToken = typeof fcmTokensTable.$inferSelect;
