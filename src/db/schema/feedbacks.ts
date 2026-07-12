import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const feedbacksTable = pgTable("feedbacks", {
  id:        serial("id").primaryKey(),
  type:      text("type").notNull().default("bug"),     // bug | feedback | contact
  title:     text("title").notNull(),
  message:   text("message").notNull(),
  contact:   text("contact"),                            // email / facebook (optional)
  deviceKey: text("device_key"),
  stars:     integer("stars").notNull().default(0),      // 0–5
  status:    text("status").notNull().default("open"),   // open | resolved | wontfix
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertFeedbackSchema = createInsertSchema(feedbacksTable)
  .omit({ id: true, createdAt: true });
export type InsertFeedback = z.infer<typeof insertFeedbackSchema>;
export type Feedback = typeof feedbacksTable.$inferSelect;
