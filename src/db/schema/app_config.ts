import { pgTable, text, serial, boolean, integer, timestamp } from "drizzle-orm/pg-core";

export const appConfigTable = pgTable("app_config", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: text("value").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type AppConfig = typeof appConfigTable.$inferSelect;
