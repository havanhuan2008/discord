import { pgTable, text, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const keysTable = pgTable("keys", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  label: text("label").notNull().default(""),
  isActive: boolean("is_active").notNull().default(true),
  maxDevices: integer("max_devices").notNull().default(1),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  discordUserId: text("discord_user_id").notNull().default(""),
  note: text("note").notNull().default(""),
  tier: text("tier").notNull().default("free"), // "free" | "vip"
});

export const insertKeySchema = createInsertSchema(keysTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertKey = z.infer<typeof insertKeySchema>;
export type Key = typeof keysTable.$inferSelect;
