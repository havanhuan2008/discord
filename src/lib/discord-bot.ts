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
import { db, keysTable, devicesTable, notificationsTable } from "../db";
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

function tierBadge(tier: string): string {
  return tier === "vip" ? "👑 VIP" : "🆓 FREE";
}

const commands = [
  new SlashCommandBuilder()
    .setName("taokey")
    .setDescription("Tạo key mới")
    .addIntegerOption(o => o.setName("ngay").setDescription("Số ngày hiệu lực (0 = vĩnh viễn)").setRequired(true))
    .addStringOption(o => o.setName("loai").setDescription("Loại key: free hoặc vip (mặc định: free)").setRequired(false))
    .addIntegerOption(o => o.setName("thietbi").setDescription("Số thiết bị tối đa").setRequired(false))
    .addStringOption(o => o.setName("nhan").setDescription("Nhãn / tên key").setRequired(false))
    .addStringOption(o => o.setName("ghichu").setDescription("Ghi chú hiển thị trong app").setRequired(false))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("nangcap")
    .setDescription("Nâng cấp / hạ cấp tier của key")
    .addStringOption(o => o.setName("key").setDescription("Key cần đổi tier").setRequired(true))
    .addStringOption(o => o.setName("loai").setDescription("free hoặc vip").setRequired(true))
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
    .setDescription("Khóa key (người dùng bị đẩy ra ngay lập tức)")
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

  new SlashCommandBuilder()
    .setName("thongbao")
    .setDescription("Gửi thông báo đến TẤT CẢ người dùng đang dùng app")
    .addStringOption(o => o.setName("tieude").setDescription("Tiêu đề thông báo").setRequired(true))
    .addStringOption(o => o.setName("noidung").setDescription("Nội dung thông báo").setRequired(true))
    .toJSON(),
];

async function findKey(keyStr: string) {
  const [record] = await db.select().from(keysTable).where(eq(keysTable.key, keyStr));
  return record ?? null;
}

async function handleInteraction(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });

  try {
    const cmd = interaction.commandName;

    // ── /taokey ───────────────────────────────────────────────────────────────
    if (cmd === "taokey") {
      const days      = interaction.options.getInteger("ngay", true);
      const tierInput = interaction.options.getString("loai") ?? "free";
      const maxDev    = interaction.options.getInteger("thietbi") ?? 1;
      const label     = interaction.options.getString("nhan") ?? "";
      const note      = interaction.options.getString("ghichu") ?? "";
      const tier      = ["free", "vip"].includes(tierInput.toLowerCase()) ? tierInput.toLowerCase() : "free";

      const key = generateKey();
      const expiresAt = days > 0 ? new Date(Date.now() + days * 86400000) : null;

      const [record] = await db.insert(keysTable).values({
        key,
        label,
        note,
        maxDevices: maxDev,
        expiresAt,
        discordUserId: interaction.user.id,
        tier,
      }).returning();

      const embed = new EmbedBuilder()
        .setColor(tier === "vip" ? 0xffd700 : 0x00bcd4)
        .setTitle(`${tier === "vip" ? "👑" : "🆓"} Key đã được tạo`)
        .addFields(
          { name: "🔑 Key",        value: `\`${record.key}\``,            inline: false },
          { name: "📛 Nhãn",       value: label || "—",                   inline: true  },
          { name: "🎯 Loại",       value: tierBadge(tier),                inline: true  },
          { name: "📅 Hết hạn",    value: formatDate(expiresAt),          inline: true  },
          { name: "📱 Thiết bị",   value: `${maxDev}`,                    inline: true  },
          { name: "📝 Ghi chú",    value: note || "—",                    inline: false },
        )
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    }

    // ── /nangcap ─────────────────────────────────────────────────────────────
    else if (cmd === "nangcap") {
      const keyStr    = interaction.options.getString("key", true);
      const tierInput = interaction.options.getString("loai", true).toLowerCase();

      if (!["free", "vip"].includes(tierInput)) {
        await interaction.editReply("❌ Loại phải là `free` hoặc `vip`.");
        return;
      }

      const record = await findKey(keyStr);
      if (!record) { await interaction.editReply("❌ Không tìm thấy key."); return; }

      await db.update(keysTable).set({ tier: tierInput }).where(eq(keysTable.id, record.id));

      const embed = new EmbedBuilder()
        .setColor(tierInput === "vip" ? 0xffd700 : 0x00bcd4)
        .setTitle("🔄 Đã đổi tier key")
        .addFields(
          { name: "🔑 Key",    value: `\`${record.key}\``,  inline: false },
          { name: "🎯 Tier mới", value: tierBadge(tierInput), inline: true  },
        )
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    }

    // ── /xemkey ──────────────────────────────────────────────────────────────
    else if (cmd === "xemkey") {
      const keyStr = interaction.options.getString("key", true);
      const record = await findKey(keyStr);
      if (!record) { await interaction.editReply("❌ Không tìm thấy key."); return; }

      const devices = await db.select().from(devicesTable).where(eq(devicesTable.keyId, record.id));

      const embed = new EmbedBuilder()
        .setColor(record.isActive ? 0x00e676 : 0xff1744)
        .setTitle(`${statusEmoji(record)} Key Info`)
        .addFields(
          { name: "🔑 Key",      value: `\`${record.key}\``,                    inline: false },
          { name: "📛 Nhãn",     value: record.label || "—",                    inline: true  },
          { name: "🎯 Tier",     value: tierBadge(record.tier),                 inline: true  },
          { name: "📅 Hết hạn",  value: formatDate(record.expiresAt),           inline: true  },
          { name: "📱 Thiết bị", value: `${devices.length}/${record.maxDevices}`, inline: true  },
          { name: "📝 Ghi chú",  value: record.note || "—",                     inline: false },
        )
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    }

    // ── /danhsachkey ─────────────────────────────────────────────────────────
    else if (cmd === "danhsachkey") {
      const keys = await db.select().from(keysTable).orderBy(keysTable.createdAt);
      const list = keys.slice(0, 20);
      if (list.length === 0) {
        await interaction.editReply("📭 Chưa có key nào.");
        return;
      }

      const lines = list.map((k, i) => {
        const exp = k.expiresAt ? `hết ${formatDate(k.expiresAt)}` : "vĩnh viễn";
        return `${i + 1}. ${statusEmoji(k)} \`${k.key}\` — ${tierBadge(k.tier)} — ${k.label || "no label"} — ${exp}`;
      });

      const embed = new EmbedBuilder()
        .setColor(0x7c4dff)
        .setTitle(`🗝️ Danh sách key (${list.length})`)
        .setDescription(lines.join("\n"))
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    }

    // ── /khoakey ─────────────────────────────────────────────────────────────
    else if (cmd === "khoakey") {
      const keyStr = interaction.options.getString("key", true);
      const record = await findKey(keyStr);
      if (!record) { await interaction.editReply("❌ Không tìm thấy key."); return; }
      if (!record.isActive) { await interaction.editReply("⚠️ Key đã bị khóa rồi."); return; }

      await db.update(keysTable).set({ isActive: false }).where(eq(keysTable.id, record.id));

      const embed = new EmbedBuilder()
        .setColor(0xff1744)
        .setTitle("🔒 Đã khóa key")
        .setDescription(`Key \`${record.key}\` đã bị khóa.\n\nNgười dùng đang dùng key này sẽ bị đăng xuất **trong vòng 2 phút**.`)
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    }

    // ── /mokey ───────────────────────────────────────────────────────────────
    else if (cmd === "mokey") {
      const keyStr = interaction.options.getString("key", true);
      const record = await findKey(keyStr);
      if (!record) { await interaction.editReply("❌ Không tìm thấy key."); return; }
      if (record.isActive) { await interaction.editReply("⚠️ Key đang hoạt động rồi."); return; }

      await db.update(keysTable).set({ isActive: true }).where(eq(keysTable.id, record.id));

      const embed = new EmbedBuilder()
        .setColor(0x00e676)
        .setTitle("🔓 Đã mở khóa key")
        .addFields({ name: "🔑 Key", value: `\`${record.key}\``, inline: false })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    }

    // ── /xoakey ──────────────────────────────────────────────────────────────
    else if (cmd === "xoakey") {
      const keyStr = interaction.options.getString("key", true);
      const record = await findKey(keyStr);
      if (!record) { await interaction.editReply("❌ Không tìm thấy key."); return; }

      await db.delete(keysTable).where(eq(keysTable.id, record.id));

      const embed = new EmbedBuilder()
        .setColor(0xff6d00)
        .setTitle("🗑️ Đã xóa key")
        .addFields({ name: "🔑 Key", value: `\`${record.key}\``, inline: false })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    }

    // ── /giahan ──────────────────────────────────────────────────────────────
    else if (cmd === "giahan") {
      const keyStr = interaction.options.getString("key", true);
      const days   = interaction.options.getInteger("ngay", true);
      const record = await findKey(keyStr);
      if (!record) { await interaction.editReply("❌ Không tìm thấy key."); return; }

      const base = record.expiresAt && record.expiresAt > new Date() ? record.expiresAt : new Date();
      const newExpiry = new Date(base.getTime() + days * 86400000);
      await db.update(keysTable).set({ expiresAt: newExpiry }).where(eq(keysTable.id, record.id));

      const embed = new EmbedBuilder()
        .setColor(0x00bcd4)
        .setTitle("📅 Đã gia hạn key")
        .addFields(
          { name: "🔑 Key",        value: `\`${record.key}\``,    inline: false },
          { name: "➕ Thêm",        value: `${days} ngày`,         inline: true  },
          { name: "📅 Hết hạn mới", value: formatDate(newExpiry),  inline: true  },
        )
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    }

    // ── /thietbi ─────────────────────────────────────────────────────────────
    else if (cmd === "thietbi") {
      const keyStr = interaction.options.getString("key", true);
      const record = await findKey(keyStr);
      if (!record) { await interaction.editReply("❌ Không tìm thấy key."); return; }

      const devices = await db.select().from(devicesTable).where(eq(devicesTable.keyId, record.id));
      if (devices.length === 0) {
        await interaction.editReply(`📱 Key \`${record.key}\` chưa có thiết bị nào.`);
        return;
      }

      const lines = devices.map((d, i) => {
        const ago = Math.floor((Date.now() - d.lastSeen.getTime()) / 1000);
        const agoStr = ago < 60 ? `${ago}s trước` : ago < 3600 ? `${Math.floor(ago/60)}p trước` : `${Math.floor(ago/3600)}h trước`;
        return `${i + 1}. 📱 **${d.deviceName}** | ID: \`${d.deviceId.substring(0, 8)}...\` | ${agoStr}`;
      });

      const embed = new EmbedBuilder()
        .setColor(0x7c4dff)
        .setTitle(`📱 Thiết bị của key \`${record.key}\``)
        .setDescription(lines.join("\n"))
        .setFooter({ text: `${devices.length}/${record.maxDevices} thiết bị` })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    }

    // ── /xoathietbi ──────────────────────────────────────────────────────────
    else if (cmd === "xoathietbi") {
      const keyStr = interaction.options.getString("key", true);
      const stt    = interaction.options.getInteger("stt", true);
      const record = await findKey(keyStr);
      if (!record) { await interaction.editReply("❌ Không tìm thấy key."); return; }

      const devices = await db.select().from(devicesTable).where(eq(devicesTable.keyId, record.id));
      const target  = devices[stt - 1];
      if (!target) { await interaction.editReply(`❌ Không có thiết bị số ${stt}.`); return; }

      await db.delete(devicesTable).where(eq(devicesTable.id, target.id));

      await interaction.editReply(`✅ Đã xóa thiết bị **${target.deviceName}** khỏi key \`${record.key}\`.`);
    }

    // ── /thongke ─────────────────────────────────────────────────────────────
    else if (cmd === "thongke") {
      const [{ total }]   = await db.select({ total: sql<number>`count(*)` }).from(keysTable);
      const [{ active }]  = await db.select({ active: sql<number>`count(*)` }).from(keysTable).where(eq(keysTable.isActive, true));
      const [{ devices }] = await db.select({ devices: sql<number>`count(*)` }).from(devicesTable);
      const [{ vip }]     = await db.select({ vip: sql<number>`count(*)` }).from(keysTable).where(and(eq(keysTable.isActive, true), eq(keysTable.tier, "vip")));

      const now = new Date();
      const expiredKeys = await db.select().from(keysTable).where(
        and(eq(keysTable.isActive, true), sql`${keysTable.expiresAt} < ${now}`)
      );

      const embed = new EmbedBuilder()
        .setColor(0x7c4dff)
        .setTitle("📊 Thống kê hệ thống")
        .addFields(
          { name: "🗝️ Tổng key",    value: `${Number(total)}`,            inline: true },
          { name: "✅ Đang hoạt động", value: `${Number(active)}`,         inline: true },
          { name: "⛔ Hết hạn",      value: `${expiredKeys.length}`,       inline: true },
          { name: "👑 VIP",          value: `${Number(vip)}`,              inline: true },
          { name: "🆓 FREE",         value: `${Number(active) - Number(vip)}`, inline: true },
          { name: "📱 Thiết bị",     value: `${Number(devices)}`,          inline: true },
        )
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    }

    // ── /online ──────────────────────────────────────────────────────────────
    else if (cmd === "online") {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
      const onlineDevices = await db.select().from(devicesTable)
        .where(sql`${devicesTable.lastSeen} > ${fiveMinAgo}`);

      if (onlineDevices.length === 0) {
        await interaction.editReply("😴 Không có thiết bị nào online trong 5 phút gần nhất.");
        return;
      }

      const lines = await Promise.all(onlineDevices.map(async d => {
        const [k] = await db.select().from(keysTable).where(eq(keysTable.id, d.keyId));
        const ago = Math.floor((Date.now() - d.lastSeen.getTime()) / 1000);
        const badge = k?.tier === "vip" ? "👑" : "🆓";
        return `🟢 ${badge} **${d.deviceName}** | Key: \`${k?.key ?? "?"}\` | ${ago < 60 ? `${ago}s` : `${Math.floor(ago / 60)}p`} trước`;
      }));

      const embed = new EmbedBuilder()
        .setColor(0x00e676)
        .setTitle(`🟢 Thiết bị đang online (${onlineDevices.length})`)
        .setDescription(lines.join("\n"))
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    }

    // ── /thongbao ─────────────────────────────────────────────────────────────
    else if (cmd === "thongbao") {
      const title = interaction.options.getString("tieude", true);
      const body  = interaction.options.getString("noidung", true);

      const [notif] = await db.insert(notificationsTable).values({
        title,
        body,
        sentBy: interaction.user.tag,
      }).returning();

      const embed = new EmbedBuilder()
        .setColor(0xff9800)
        .setTitle("📢 Đã gửi thông báo")
        .setDescription("Thông báo sẽ hiển thị với **tất cả người dùng** khi họ mở app hoặc trong lần heartbeat tiếp theo (≤2 phút).")
        .addFields(
          { name: "📌 Tiêu đề",  value: title, inline: false },
          { name: "📝 Nội dung", value: body,  inline: false },
        )
        .setFooter({ text: `ID: ${notif.id} · Bởi: ${interaction.user.tag}` })
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

  client.once("clientReady", async () => {
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
