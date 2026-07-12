import { pgTable, text, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";

// Phiên chat giữa một người dùng và admin
export const chatSessionsTable = pgTable("chat_sessions", {
  id: serial("id").primaryKey(),
  deviceId: text("device_id").notNull(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull().default(""),
  status: text("status").notNull().default("pending"), // "pending" | "accepted" | "closed"
  adminAvatar: text("admin_avatar").notNull().default(""),   // Discord avatar URL khi accepted
  adminName: text("admin_name").notNull().default(""),       // Tên admin trên Discord
  adminOnline: boolean("admin_online").notNull().default(false),
  discordChannelId: text("discord_channel_id"),             // Channel ID Discord (nếu dùng thread)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Tin nhắn trong phiên chat
export const chatMessagesTable = pgTable("chat_messages", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull(),
  sender: text("sender").notNull(),  // "user" | "bot" | "admin"
  content: text("content").notNull().default(""),
  type: text("type").notNull().default("text"), // "text" | "image" | "emoji"
  imageData: text("image_data"),   // base64 or Discord CDN URL for images
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
