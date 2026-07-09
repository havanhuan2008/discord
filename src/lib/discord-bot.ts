import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { eq, and, sql } from "drizzle-orm";
import { db, keysTable, devicesTable } from "../db";
import { logger } from "./logger";

const TOKEN    = process.env.DISCORD_BOT_TOKEN ?? "";
const GUILD_ID = process.env.DISCORD_GUILD_ID  ?? "";

function generateKey(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const seg = () =>
    Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `${seg()}-${seg()}-${seg()}-${seg()}`;
}

function formatDate(d: Date | null | undefined): string {
  if (!d) return "Không giới hạn";
  return d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function statusEmoji(k: { isActive: boolean; expiresAt: Date | null }): string {
  if (!k.isActive) return "🔒";
  if (k.expiresAt && k.expiresAt < new Date()) return "⛔";
  return "✅";
}

const commands = [
  new SlashCommandBuilder()
    .setName("taokey")
    .setDescription("Tạo key mới")
    .addIntegerOption(o => o.setName("ngay").setDescription("Số ngày hiệu lực (0 = vĩnh viễn)").setRequired(true))
    .addIntegerOption(o => o.setName("thietbi").setDescription("Số thiết bị tối đa").setRequired(false))
    .addStringOption(o => o.setName("nhan").setDescription("Nhãn / tên key").setRequired(false))
    .addStringOption(o => o.setName("ghichu").setDescription("Ghi chú").setRequired(false))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("xemkey")
    .setDescription("Xem thông tin một key")
    .addStringOption(o => o.setName("key").setDescription("Key cần xem").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("danhsachkey")
    .setDescription("Xem toàn bộ key (tối đa 20)")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("khoakey")
    .setDescription("Khóa key")
    .addStringOption(o => o.setName("key").setDescription("Key cần khóa").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("mokey")
    .setDescription("Mở khóa key")
    .addStringOption(o => o.setName("key").setDescription("Key cần mở").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("xoakey")
    .setDescription("Xóa key vĩnh viễn")
    .addStringOption(o => o.setName("key").setDescription("Key cần xóa").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("giahan")
    .setDescription("Gia hạn key thêm N ngày")
    .addStringOption(o => o.setName("key").setDescription("Key cần gia hạn").setRequired(true))
    .addIntegerOption(o => o.setName("ngay").setDescription("Số ngày thêm").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("thietbi")
    .setDescription("Xem thiết bị đang đăng nhập của key")
    .addStringOption(o => o.setName("key").setDescription("Key cần xem").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("xoathietbi")
    .setDescription("Xóa thiết bị khỏi key (theo thứ tự trong /thietbi)")
    .addStringOption(o => o.setName("key").setDescription("Key").setRequired(true))
    .addIntegerOption(o => o.setName("stt").setDescription("Số thứ tự thiết bị").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("thongke")
    .setDescription("Thống kê tổng quan hệ thống key")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("online")
    .setDescription("Xem thiết bị online trong 5 phút gần nhất")
    .toJSON(),
];

async function findKey(keyStr: string) {
  const [record] = await db.select().from(keysTable).where(eq(keysTable.key, keyStr));
  return record ?? null;
}

async function handleInteraction(interaction: ChatInputCommandInteraction) {
  if (!interaction.isChatInputCommand()) return;

  const name = interaction.commandName;
  await interaction.deferReply({ ephemeral: false });

  try {
    if (name === "taokey") {
      const days      = interaction.options.getInteger("ngay", true);
      const maxDev    = interaction.options.getInteger("thietbi") ?? 1;
      const label     = interaction.options.getString("nhan") ?? "";
      const note      = interaction.options.getString("ghichu") ?? "";
      const key       = generateKey();
      const expiresAt = days > 0 ? new Date(Date.now() + days * 86400000) : null;

      const [record] = await db.insert(keysTable).values({
        key, label, maxDevices: maxDev, isActive: true,
        expiresAt: expiresAt ?? undefined,
        discordUserId: interaction.user.id,
        note,
      }).returning();

      const embed = new EmbedBuilder()
        .setColor(0x00e676)
        .setTitle("✅ Tạo key thành công")
        .addFields(
          { name: "🔑 Key", value: `\`${record.key}\``, inline: false },
          { name: "🏷️ Nhãn", value: label || "—", inline: true },
          { name: "📱 Thiết bị tối đa", value: `${maxDev}`, inline: true },
          { name: "⏳ Hết hạn", value: days === 0 ? "Vĩnh viễn" : `${days} ngày (${formatDate(expiresAt)})`, inline: false },
          { name: "📝 Ghi chú", value: note || "—", inline: false },
        )
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });

    } else if (name === "xemkey") {
      const keyStr = interaction.options.getString("key", true).trim().toUpperCase();
      const record = await findKey(keyStr);
      if (!record) {
        await interaction.editReply("❌ Không tìm thấy key này.");
        return;
      }
      const devices = await db.select().from(devicesTable).where(eq(devicesTable.keyId, record.id));
      const embed = new EmbedBuilder()
        .setColor(record.isActive ? 0x00e676 : 0xff1744)
        .setTitle(`${statusEmoji(record)} Key Info`)
        .addFields(
          { name: "🔑 Key", value: `\`${record.key}\``, inline: false },
          { name: "🏷️ Nhãn", value: record.label || "—", inline: true },
          { name: "📌 Trạng thái", value: record.isActive ? "Hoạt động" : "Đã khóa", inline: true },
          { name: "📱 Thiết bị", value: `${devices.length}/${record.maxDevices}`, inline: true },
          { name: "⏳ Hết hạn", value: formatDate(record.expiresAt), inline: true },
          { name: "📅 Tạo lúc", value: formatDate(record.createdAt), inline: true },
          { name: "📝 Ghi chú", value: record.note || "—", inline: false },
        )
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });

    } else if (name === "danhsachkey") {
      const keys = await db.select().from(keysTable).orderBy(keysTable.createdAt).limit(20);
      if (keys.length === 0) {
        await interaction.editReply("📭 Chưa có key nào.");
        return;
      }
      const lines = await Promise.all(keys.map(async (k, i) => {
        const devs = await db.select().from(devicesTable).where(eq(devicesTable.keyId, k.id));
        const exp = k.expiresAt ? formatDate(k.expiresAt) : "Vĩnh viễn";
        return `**${i + 1}.** \`${k.key}\` ${statusEmoji(k)} | 📱${devs.length}/${k.maxDevices} | ⏳${exp}${k.label ? ` | ${k.label}` : ""}`;
      }));
      const embed = new EmbedBuilder()
        .setColor(0xff1744)
        .setTitle(`🗝️ Danh sách key (${keys.length})`)
        .setDescription(lines.join("\n"))
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });

    } else if (name === "khoakey") {
      const keyStr = interaction.options.getString("key", true).trim().toUpperCase();
      const record = await findKey(keyStr);
      if (!record) { await interaction.editReply("❌ Không tìm thấy key này."); return; }
      await db.update(keysTable).set({ isActive: false }).where(eq(keysTable.id, record.id));
      await interaction.editReply(`🔒 Đã khóa key \`${record.key}\``);

    } else if (name === "mokey") {
      const keyStr = interaction.options.getString("key", true).trim().toUpperCase();
      const record = await findKey(keyStr);
      if (!record) { await interaction.editReply("❌ Không tìm thấy key này."); return; }
      await db.update(keysTable).set({ isActive: true }).where(eq(keysTable.id, record.id));
      await interaction.editReply(`🔓 Đã mở khóa key \`${record.key}\``);

    } else if (name === "xoakey") {
      const keyStr = interaction.options.getString("key", true).trim().toUpperCase();
      const record = await findKey(keyStr);
      if (!record) { await interaction.editReply("❌ Không tìm thấy key này."); return; }
      await db.delete(keysTable).where(eq(keysTable.id, record.id));
      await interaction.editReply(`🗑️ Đã xóa key \`${record.key}\` vĩnh viễn.`);

    } else if (name === "giahan") {
      const keyStr = interaction.options.getString("key", true).trim().toUpperCase();
      const days   = interaction.options.getInteger("ngay", true);
      const record = await findKey(keyStr);
      if (!record) { await interaction.editReply("❌ Không tìm thấy key này."); return; }
      const base = record.expiresAt && record.expiresAt > new Date() ? record.expiresAt : new Date();
      const newExpiry = new Date(base.getTime() + days * 86400000);
      await db.update(keysTable).set({ expiresAt: newExpiry }).where(eq(keysTable.id, record.id));
      await interaction.editReply(`✅ Đã gia hạn key \`${record.key}\` thêm **${days} ngày**.\nHết hạn mới: **${formatDate(newExpiry)}**`);

    } else if (name === "thietbi") {
      const keyStr = interaction.options.getString("key", true).trim().toUpperCase();
      const record = await findKey(keyStr);
      if (!record) { await interaction.editReply("❌ Không tìm thấy key này."); return; }
      const devices = await db.select().from(devicesTable).where(eq(devicesTable.keyId, record.id));
      if (devices.length === 0) {
        await interaction.editReply(`📱 Key \`${record.key}\` chưa có thiết bị nào đăng nhập.`);
        return;
      }
      const lines = devices.map((d, i) => {
        const ago = Math.floor((Date.now() - d.lastSeen.getTime()) / 60000);
        const onlineBadge = ago < 5 ? "🟢" : "⚫";
        return `**${i + 1}.** ${onlineBadge} ${d.deviceName} | ID: \`${d.deviceId.slice(0, 8)}...\` | ${ago < 1 ? "Vừa xong" : `${ago} phút trước`}`;
      });
      const embed = new EmbedBuilder()
        .setColor(0x2196f3)
        .setTitle(`📱 Thiết bị của \`${record.key}\` (${devices.length}/${record.maxDevices})`)
        .setDescription(lines.join("\n"))
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });

    } else if (name === "xoathietbi") {
      const keyStr = interaction.options.getString("key", true).trim().toUpperCase();
      const stt    = interaction.options.getInteger("stt", true);
      const record = await findKey(keyStr);
      if (!record) { await interaction.editReply("❌ Không tìm thấy key này."); return; }
      const devices = await db.select().from(devicesTable).where(eq(devicesTable.keyId, record.id));
      const target  = devices[stt - 1];
      if (!target) { await interaction.editReply(`❌ Không có thiết bị số ${stt}.`); return; }
      await db.delete(devicesTable).where(eq(devicesTable.id, target.id));
      await interaction.editReply(`✅ Đã xóa thiết bị **${target.deviceName}** khỏi key \`${record.key}\`.`);

    } else if (name === "thongke") {
      const [{ total }]   = await db.select({ total: sql<number>`count(*)` }).from(keysTable);
      const [{ active }]  = await db.select({ active: sql<number>`count(*)` }).from(keysTable).where(eq(keysTable.isActive, true));
      const [{ devices }] = await db.select({ devices: sql<number>`count(*)` }).from(devicesTable);
      const now = new Date();
      const fiveMinsAgo = new Date(now.getTime() - 5 * 60000);
      const [{ onlineCount }] = await db.select({ onlineCount: sql<number>`count(distinct key_id)` })
        .from(devicesTable).where(sql`${devicesTable.lastSeen} > ${fiveMinsAgo}`);

      const embed = new EmbedBuilder()
        .setColor(0xff9800)
        .setTitle("📊 Thống kê hệ thống")
        .addFields(
          { name: "🗝️ Tổng key",      value: `${total}`,       inline: true },
          { name: "✅ Key hoạt động", value: `${active}`,      inline: true },
          { name: "🔒 Key bị khóa",   value: `${Number(total) - Number(active)}`, inline: true },
          { name: "📱 Tổng thiết bị", value: `${devices}`,     inline: true },
          { name: "🟢 Online (5p)",    value: `${onlineCount}`, inline: true },
        )
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });

    } else if (name === "online") {
      const fiveMinsAgo = new Date(Date.now() - 5 * 60000);
      const onlineDevices = await db.select().from(devicesTable)
        .where(sql`${devicesTable.lastSeen} > ${fiveMinsAgo}`);

      if (onlineDevices.length === 0) {
        await interaction.editReply("🔴 Không có thiết bị nào online trong 5 phút gần nhất.");
        return;
      }

      const lines = await Promise.all(onlineDevices.map(async d => {
        const [k] = await db.select().from(keysTable).where(eq(keysTable.id, d.keyId));
        const ago = Math.floor((Date.now() - d.lastSeen.getTime()) / 1000);
        return `🟢 **${d.deviceName}** | Key: \`${k?.key ?? "?"}\` | ${ago < 60 ? `${ago}s` : `${Math.floor(ago / 60)}p`} trước`;
      }));

      const embed = new EmbedBuilder()
        .setColor(0x00e676)
        .setTitle(`🟢 Thiết bị đang online (${onlineDevices.length})`)
        .setDescription(lines.join("\n"))
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    }
  } catch (err) {
    logger.error({ err }, "Discord command error");
    await interaction.editReply("❌ Có lỗi xảy ra. Vui lòng thử lại.");
  }
}

export async function startDiscordBot(): Promise<void> {
  if (!TOKEN || !GUILD_ID) {
    logger.warn("DISCORD_BOT_TOKEN or DISCORD_GUILD_ID not set — Discord bot disabled");
    return;
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once("ready", async () => {
    logger.info({ tag: client.user?.tag }, "Discord bot ready");

    const rest = new REST({ version: "10" }).setToken(TOKEN);
    try {
      await rest.put(Routes.applicationGuildCommands(client.user!.id, GUILD_ID), { body: commands });
      logger.info("Slash commands registered");
    } catch (err) {
      logger.error({ err }, "Failed to register slash commands");
    }
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    await handleInteraction(interaction as ChatInputCommandInteraction);
  });

  client.on("error", (err) => logger.error({ err }, "Discord client error"));

  await client.login(TOKEN);
}
