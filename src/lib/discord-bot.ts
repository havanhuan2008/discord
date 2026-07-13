import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ButtonInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  PermissionFlagsBits,
} from "discord.js";
import { eq, and, sql, inArray } from "drizzle-orm";
import { db, keysTable, devicesTable, notificationsTable, notificationReadsTable, feedbacksTable, fcmTokensTable, chatSessionsTable, chatMessagesTable } from "../db/index.js";
import { logger } from "./logger.js";
import { sendFcmPush, isFcmConfigured } from "./fcm.js";

const TOKEN    = process.env.DISCORD_BOT_TOKEN ?? "";
const GUILD_ID = process.env.DISCORD_GUILD_ID  ?? "";

// Danh sách user Discord được phép chạy lệnh quản trị (ngoài quyền Administrator/ManageGuild của server).
// Đặt biến môi trường DISCORD_ADMIN_IDS="id1,id2" nếu muốn giới hạn thêm theo user cụ thể.
const EXTRA_ADMIN_IDS = new Set(
  (process.env.DISCORD_ADMIN_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean)
);

function isAuthorizedAdmin(interaction: ChatInputCommandInteraction): boolean {
  if (EXTRA_ADMIN_IDS.has(interaction.user.id)) return true;
  const member = interaction.member;
  if (!member || typeof member.permissions === "string") return false;
  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild)
  );
}

const PAGE_SIZE = 20;

function generateKey(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const seg = () =>
    Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `${seg()}-${seg()}-${seg()}-${seg()}`;
}

function normalizeCustomKey(raw: string): string {
  // Cho phép người dùng nhập tự do, chỉ chuẩn hoá về chữ hoa + khoảng trắng -> gạch ngang
  return raw.trim().toUpperCase().replace(/\s+/g, "-");
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

function paginationRow(page: number, totalPages: number, prefix: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}:first:${page}`)
      .setEmoji("⏮️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`${prefix}:prev:${page}`)
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`${prefix}:label:${page}`)
      .setLabel(`Trang ${page + 1}/${totalPages}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`${prefix}:next:${page}`)
      .setEmoji("▶️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1),
    new ButtonBuilder()
      .setCustomId(`${prefix}:last:${page}`)
      .setEmoji("⏭️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1),
  );
}

// Toàn bộ lệnh đều là lệnh quản trị. Ẩn khỏi menu với user không có quyền
// Manage Server theo mặc định (server admin có thể tùy chỉnh lại trong Server Settings > Integrations).
// Đây chỉ là lớp bảo vệ ở UI Discord — quyền thực sự vẫn được kiểm tra lại trong isAuthorizedAdmin().
const commands = [
  new SlashCommandBuilder()
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setName("taokey")
    .setDescription("Tạo key mới")
    .addIntegerOption(o => o.setName("ngay").setDescription("Số ngày hiệu lực (0 = vĩnh viễn)").setRequired(true))
    .addStringOption(o => o.setName("loai").setDescription("Loại key: free hoặc vip (mặc định: free)").setRequired(false))
    .addIntegerOption(o => o.setName("thietbi").setDescription("Số thiết bị tối đa").setRequired(false))
    .addStringOption(o => o.setName("nhan").setDescription("Nhãn / tên key").setRequired(false))
    .addStringOption(o => o.setName("ghichu").setDescription("Ghi chú hiển thị trong app").setRequired(false))
    .addStringOption(o => o.setName("key").setDescription("Tùy chỉnh nội dung key (bỏ trống để tự sinh)").setRequired(false))
    .toJSON(),

  new SlashCommandBuilder()
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setName("nangcap")
    .setDescription("Nâng cấp / hạ cấp tier của key")
    .addStringOption(o => o.setName("key").setDescription("Key cần đổi tier").setRequired(true))
    .addStringOption(o => o.setName("loai").setDescription("free hoặc vip").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setName("xemkey")
    .setDescription("Xem thông tin một key")
    .addStringOption(o => o.setName("key").setDescription("Key cần xem").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setName("danhsachkey")
    .setDescription("Xem toàn bộ key (có phân trang, không giới hạn 20)")
    .addStringOption(o =>
      o.setName("loc")
        .setDescription("Lọc theo trạng thái/loại")
        .setRequired(false)
        .addChoices(
          { name: "Tất cả", value: "all" },
          { name: "Đang hoạt động", value: "active" },
          { name: "Đã khóa", value: "locked" },
          { name: "Hết hạn", value: "expired" },
          { name: "VIP", value: "vip" },
          { name: "FREE", value: "free" },
        ))
    .toJSON(),

  new SlashCommandBuilder()
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setName("suakey")
    .setDescription("Sửa nhãn / ghi chú / số thiết bị tối đa của key")
    .addStringOption(o => o.setName("key").setDescription("Key cần sửa").setRequired(true))
    .addStringOption(o => o.setName("nhan").setDescription("Nhãn mới").setRequired(false))
    .addStringOption(o => o.setName("ghichu").setDescription("Ghi chú mới").setRequired(false))
    .addIntegerOption(o => o.setName("thietbi").setDescription("Số thiết bị tối đa mới").setRequired(false))
    .toJSON(),

  new SlashCommandBuilder()
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setName("khoakey")
    .setDescription("Khóa key (người dùng bị đẩy ra ngay lập tức)")
    .addStringOption(o => o.setName("key").setDescription("Key cần khóa").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setName("mokey")
    .setDescription("Mở khóa key")
    .addStringOption(o => o.setName("key").setDescription("Key cần mở").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setName("xoakey")
    .setDescription("Xóa key vĩnh viễn")
    .addStringOption(o => o.setName("key").setDescription("Key cần xóa").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setName("giahan")
    .setDescription("Gia hạn key thêm N ngày")
    .addStringOption(o => o.setName("key").setDescription("Key cần gia hạn").setRequired(true))
    .addIntegerOption(o => o.setName("ngay").setDescription("Số ngày thêm").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setName("thietbi")
    .setDescription("Xem thiết bị đang đăng nhập của key")
    .addStringOption(o => o.setName("key").setDescription("Key cần xem").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setName("xoathietbi")
    .setDescription("Xóa thiết bị khỏi key (theo thứ tự trong /thietbi)")
    .addStringOption(o => o.setName("key").setDescription("Key").setRequired(true))
    .addIntegerOption(o => o.setName("stt").setDescription("Số thứ tự thiết bị").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setName("thongke")
    .setDescription("Thống kê tổng quan hệ thống key")
    .toJSON(),

  new SlashCommandBuilder()
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setName("online")
    .setDescription("Xem thiết bị online trong 5 phút gần nhất")
    .toJSON(),

  new SlashCommandBuilder()
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setName("thongbao")
    .setDescription("Gửi thông báo đến TẤT CẢ người dùng đang dùng app")
    .addStringOption(o => o.setName("tieude").setDescription("Tiêu đề thông báo").setRequired(true))
    .addStringOption(o => o.setName("noidung").setDescription("Nội dung thông báo").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setName("danhsachthongbao")
    .setDescription("Xem danh sách thông báo đã gửi (có phân trang)")
    .toJSON(),

  new SlashCommandBuilder()
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setName("xoathongbao")
    .setDescription("Xóa một thông báo theo ID")
    .addIntegerOption(o => o.setName("id").setDescription("ID thông báo (xem trong /danhsachthongbao)").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setName("xoatatthongbao")
    .setDescription("Xóa TẤT CẢ thông báo đã gửi")
    .toJSON(),

  new SlashCommandBuilder()
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setName("xoatatkey")
    .setDescription("⚠️ Xóa HÀNG LOẠT key (yêu cầu xác nhận)")
    .addStringOption(o =>
      o.setName("loc")
        .setDescription("Nhóm key cần xóa (mặc định: tất cả)")
        .setRequired(false)
        .addChoices(
          { name: "Tất cả key",         value: "all"     },
          { name: "Chỉ key FREE",        value: "free"    },
          { name: "Chỉ key hết hạn",     value: "expired" },
          { name: "Chỉ key đã khóa",     value: "locked"  },
        ))
    .toJSON(),

  // ── Góp ý / Báo lỗi ──────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setName("goyphan")
    .setDescription("Xem danh sách báo lỗi & góp ý từ người dùng")
    .addStringOption(o =>
      o.setName("loai")
        .setDescription("Lọc theo loại")
        .setRequired(false)
        .addChoices(
          { name: "Tất cả",        value: "all"      },
          { name: "Báo lỗi",       value: "bug"      },
          { name: "Góp ý",         value: "feedback" },
          { name: "Liên hệ hỗ trợ", value: "contact" },
        ))
    .toJSON(),


  // ── Chat hỗ trợ ──────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setName("chatchapnhan")
    .setDescription("✅ Chấp nhận yêu cầu chat của người dùng")
    .addIntegerOption(o => o.setName("id").setDescription("Session ID của phiên chat").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setName("chatra")
    .setDescription("💬 Trả lời người dùng trong phiên chat")
    .addIntegerOption(o => o.setName("id").setDescription("Session ID của phiên chat").setRequired(true))
    .addStringOption(o => o.setName("tinhnhan").setDescription("Nội dung tin nhắn").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setName("chatguianh")
    .setDescription("🖼️ Gửi ảnh đến người dùng trong phiên chat")
    .addIntegerOption(o => o.setName("id").setDescription("Session ID của phiên chat").setRequired(true))
    .addStringOption(o => o.setName("url").setDescription("URL ảnh cần gửi").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setName("chatthoat")
    .setDescription("🚪 Kết thúc/đóng phiên chat với người dùng")
    .addIntegerOption(o => o.setName("id").setDescription("Session ID của phiên chat").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setName("chatdanhsach")
    .setDescription("📋 Xem danh sách các phiên chat đang chờ/hoạt động")
    .toJSON(),

  // ── Push notification đến thiết bị ───────────────────────────────────────
  new SlashCommandBuilder()
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setName("thongbaodaybp")
    .setDescription("📲 Gửi push notification đến TẤT CẢ thiết bị (kể cả khi app đóng)")
    .addStringOption(o => o.setName("tieude").setDescription("Tiêu đề thông báo").setRequired(true))
    .addStringOption(o => o.setName("noidung").setDescription("Nội dung thông báo").setRequired(true))
    .toJSON(),
];

async function findKey(keyStr: string) {
  const [record] = await db.select().from(keysTable).where(eq(keysTable.key, keyStr));
  return record ?? null;
}

// ── Danh sách key: build embed cho 1 trang ──────────────────────────────────
function buildKeyListEmbed(
  keys: Array<typeof keysTable.$inferSelect>,
  page: number,
  totalPages: number,
  totalCount: number,
  filterLabel: string,
) {
  const start = page * PAGE_SIZE;
  const pageItems = keys.slice(start, start + PAGE_SIZE);

  const lines = pageItems.map((k, i) => {
    const exp = k.expiresAt ? `hết ${formatDate(k.expiresAt)}` : "vĩnh viễn";
    return `${start + i + 1}. ${statusEmoji(k)} \`${k.key}\` — ${tierBadge(k.tier)} — ${k.label || "no label"} — ${exp}`;
  });

  return new EmbedBuilder()
    .setColor(0x7c4dff)
    .setTitle(`🗝️ Danh sách key (${totalCount}) ${filterLabel}`)
    .setDescription(lines.length ? lines.join("\n") : "📭 Không có key phù hợp.")
    .setFooter({ text: `Trang ${page + 1}/${totalPages} · ${PAGE_SIZE} key/trang` })
    .setTimestamp();
}

async function fetchKeysForFilter(filter: string) {
  const all = await db.select().from(keysTable).orderBy(keysTable.createdAt);
  const now = new Date();
  switch (filter) {
    case "active":
      return all.filter((k: typeof all[number]) => k.isActive && !(k.expiresAt && k.expiresAt < now));
    case "locked":
      return all.filter((k: typeof all[number]) => !k.isActive);
    case "expired":
      return all.filter((k: typeof all[number]) => k.isActive && k.expiresAt && k.expiresAt < now);
    case "vip":
      return all.filter((k: typeof all[number]) => k.tier === "vip");
    case "free":
      return all.filter((k: typeof all[number]) => k.tier === "free");
    default:
      return all;
  }
}

function filterDisplayLabel(filter: string): string {
  switch (filter) {
    case "active": return "· Đang hoạt động";
    case "locked": return "· Đã khóa";
    case "expired": return "· Hết hạn";
    case "vip": return "· VIP";
    case "free": return "· FREE";
    default: return "";
  }
}

// ── Danh sách thông báo: build embed cho 1 trang ────────────────────────────
function buildNotifListEmbed(
  notifs: Array<typeof notificationsTable.$inferSelect>,
  page: number,
  totalPages: number,
  totalCount: number,
) {
  const start = page * PAGE_SIZE;
  const pageItems = notifs.slice(start, start + PAGE_SIZE);

  const lines = pageItems.map((n, i) => {
    const body = n.body.length > 80 ? `${n.body.slice(0, 80)}…` : n.body;
    return `**#${n.id}** — 📌 ${n.title}\n📝 ${body}\n👤 ${n.sentBy} · 🕒 ${formatDate(n.createdAt)}`;
  });

  return new EmbedBuilder()
    .setColor(0xff9800)
    .setTitle(`📢 Danh sách thông báo (${totalCount})`)
    .setDescription(lines.length ? lines.join("\n\n") : "📭 Chưa có thông báo nào.")
    .setFooter({ text: `Trang ${page + 1}/${totalPages} · ${PAGE_SIZE} thông báo/trang · Dùng /xoathongbao <id> để xóa` })
    .setTimestamp();
}

async function handleInteraction(interaction: ChatInputCommandInteraction) {
  if (!isAuthorizedAdmin(interaction)) {
    await interaction.reply({
      content: "❌ Bạn không có quyền sử dụng lệnh quản trị này.",
      flags: 64,
    });
    return;
  }

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
      const customKey = interaction.options.getString("key");
      const tier      = ["free", "vip"].includes(tierInput.toLowerCase()) ? tierInput.toLowerCase() : "free";

      let key: string;
      if (customKey && customKey.trim().length > 0) {
        key = normalizeCustomKey(customKey);
        if (key.length < 4) {
          await interaction.editReply("❌ Key tùy chỉnh phải có ít nhất 4 ký tự.");
          return;
        }
        const existing = await findKey(key);
        if (existing) {
          await interaction.editReply(`❌ Key \`${key}\` đã tồn tại. Vui lòng chọn nội dung khác.`);
          return;
        }
      } else {
        key = generateKey();
      }

      const expiresAt = days > 0 ? new Date(Date.now() + days * 86400000) : null;

      let record: typeof keysTable.$inferSelect;
      try {
        [record] = await db.insert(keysTable).values({
          key,
          label,
          note,
          maxDevices: maxDev,
          expiresAt,
          discordUserId: interaction.user.id,
          tier,
        }).returning();
      } catch (err: any) {
        if (err?.code === "23505") {
          await interaction.editReply(`❌ Key \`${key}\` đã tồn tại (trùng lặp). Vui lòng thử lại.`);
          return;
        }
        throw err;
      }

      const embed = new EmbedBuilder()
        .setColor(tier === "vip" ? 0xffd700 : 0x00bcd4)
        .setTitle(`${tier === "vip" ? "👑" : "🆓"} Key đã được tạo${customKey ? " (tùy chỉnh)" : ""}`)
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
      const filter = interaction.options.getString("loc") ?? "all";
      const keys = await fetchKeysForFilter(filter);

      if (keys.length === 0) {
        await interaction.editReply("📭 Không có key phù hợp.");
        return;
      }

      let totalPages = Math.max(1, Math.ceil(keys.length / PAGE_SIZE));
      let page = 0;

      const embed = buildKeyListEmbed(keys, page, totalPages, keys.length, filterDisplayLabel(filter));
      const components = totalPages > 1 ? [paginationRow(page, totalPages, "keylist")] : [];

      const message = await interaction.editReply({ embeds: [embed], components });
      if (totalPages <= 1) return;

      const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 5 * 60 * 1000,
      });

      let busy = false;
      collector.on("collect", async (btn: ButtonInteraction) => {
        if (btn.user.id !== interaction.user.id) {
          await btn.reply({ content: "❌ Bạn không thể điều khiển danh sách này.", flags: 64 });
          return;
        }
        // Chặn click liên tiếp trong khi request trước đang xử lý, tránh cập nhật trang lệch thứ tự.
        if (busy) {
          await btn.deferUpdate().catch(() => {});
          return;
        }
        busy = true;
        try {
          const [, action] = btn.customId.split(":");
          if (action === "first") page = 0;
          else if (action === "prev") page = Math.max(0, page - 1);
          else if (action === "next") page = Math.min(totalPages - 1, page + 1);
          else if (action === "last") page = totalPages - 1;

          const freshKeys = await fetchKeysForFilter(filter);
          const newTotalPages = Math.max(1, Math.ceil(freshKeys.length / PAGE_SIZE));
          page = Math.min(page, newTotalPages - 1);
          totalPages = newTotalPages;

          const newEmbed = buildKeyListEmbed(freshKeys, page, newTotalPages, freshKeys.length, filterDisplayLabel(filter));
          await btn.update({ embeds: [newEmbed], components: [paginationRow(page, newTotalPages, "keylist")] });
        } finally {
          busy = false;
        }
      });

      collector.on("end", async () => {
        await message.edit({ components: [] }).catch(() => {});
      });
    }

    // ── /suakey ──────────────────────────────────────────────────────────────
    else if (cmd === "suakey") {
      const keyStr = interaction.options.getString("key", true);
      const label  = interaction.options.getString("nhan");
      const note   = interaction.options.getString("ghichu");
      const maxDev = interaction.options.getInteger("thietbi");

      const record = await findKey(keyStr);
      if (!record) { await interaction.editReply("❌ Không tìm thấy key."); return; }

      if (label === null && note === null && maxDev === null) {
        await interaction.editReply("⚠️ Cần cung cấp ít nhất một trong: nhãn, ghichú, thietbi.");
        return;
      }

      const patch: Partial<typeof keysTable.$inferInsert> = {};
      if (label !== null) patch.label = label;
      if (note !== null) patch.note = note;
      if (maxDev !== null) patch.maxDevices = maxDev;

      const [updated] = await db.update(keysTable).set(patch).where(eq(keysTable.id, record.id)).returning();

      const embed = new EmbedBuilder()
        .setColor(0x00bcd4)
        .setTitle("✏️ Đã cập nhật key")
        .addFields(
          { name: "🔑 Key",      value: `\`${updated.key}\``,      inline: false },
          { name: "📛 Nhãn",     value: updated.label || "—",       inline: true  },
          { name: "📱 Thiết bị", value: `${updated.maxDevices}`,    inline: true  },
          { name: "📝 Ghi chú",  value: updated.note || "—",        inline: false },
        )
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
      const [{ notifs }]  = await db.select({ notifs: sql<number>`count(*)` }).from(notificationsTable);

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
          { name: "📢 Thông báo",    value: `${Number(notifs)}`,           inline: true },
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

    // ── /danhsachthongbao ────────────────────────────────────────────────────
    else if (cmd === "danhsachthongbao") {
      const notifs = await db.select().from(notificationsTable).orderBy(sql`${notificationsTable.createdAt} DESC`);

      if (notifs.length === 0) {
        await interaction.editReply("📭 Chưa có thông báo nào.");
        return;
      }

      let totalPages = Math.max(1, Math.ceil(notifs.length / PAGE_SIZE));
      let page = 0;

      const embed = buildNotifListEmbed(notifs, page, totalPages, notifs.length);
      const components = totalPages > 1 ? [paginationRow(page, totalPages, "notiflist")] : [];

      const message = await interaction.editReply({ embeds: [embed], components });
      if (totalPages <= 1) return;

      const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 5 * 60 * 1000,
      });

      let busy = false;
      collector.on("collect", async (btn: ButtonInteraction) => {
        if (btn.user.id !== interaction.user.id) {
          await btn.reply({ content: "❌ Bạn không thể điều khiển danh sách này.", flags: 64 });
          return;
        }
        if (busy) {
          await btn.deferUpdate().catch(() => {});
          return;
        }
        busy = true;
        try {
          const [, action] = btn.customId.split(":");
          if (action === "first") page = 0;
          else if (action === "prev") page = Math.max(0, page - 1);
          else if (action === "next") page = Math.min(totalPages - 1, page + 1);
          else if (action === "last") page = totalPages - 1;

          const freshNotifs = await db.select().from(notificationsTable).orderBy(sql`${notificationsTable.createdAt} DESC`);
          const newTotalPages = Math.max(1, Math.ceil(freshNotifs.length / PAGE_SIZE));
          page = Math.min(page, newTotalPages - 1);
          totalPages = newTotalPages;

          const newEmbed = buildNotifListEmbed(freshNotifs, page, newTotalPages, freshNotifs.length);
          await btn.update({ embeds: [newEmbed], components: [paginationRow(page, newTotalPages, "notiflist")] });
        } finally {
          busy = false;
        }
      });

      collector.on("end", async () => {
        await message.edit({ components: [] }).catch(() => {});
      });
    }

    // ── /xoathongbao ─────────────────────────────────────────────────────────
    else if (cmd === "xoathongbao") {
      const id = interaction.options.getInteger("id", true);
      const [existing] = await db.select().from(notificationsTable).where(eq(notificationsTable.id, id));
      if (!existing) { await interaction.editReply(`❌ Không tìm thấy thông báo #${id}.`); return; }

      await db.delete(notificationsTable).where(eq(notificationsTable.id, id));
      await db.delete(notificationReadsTable).where(eq(notificationReadsTable.notificationId, id));

      const embed = new EmbedBuilder()
        .setColor(0xff6d00)
        .setTitle("🗑️ Đã xóa thông báo")
        .addFields(
          { name: "🆔 ID",       value: `#${existing.id}`,   inline: true  },
          { name: "📌 Tiêu đề",  value: existing.title,      inline: true  },
        )
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    }

    // ── /xoatatthongbao ──────────────────────────────────────────────────────
    else if (cmd === "xoatatthongbao") {
      const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(notificationsTable);
      if (Number(count) === 0) {
        await interaction.editReply("📭 Không có thông báo nào để xóa.");
        return;
      }

      await db.delete(notificationReadsTable);
      await db.delete(notificationsTable);

      const embed = new EmbedBuilder()
        .setColor(0xff1744)
        .setTitle("🗑️ Đã xóa tất cả thông báo")
        .setDescription(`Đã xóa **${Number(count)}** thông báo.`)
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    }

    // ── /xoatatkey ───────────────────────────────────────────────────────────
    else if (cmd === "xoatatkey") {
      const filter = interaction.options.getString("loc") ?? "all";

      // Label cho từng loại
      const filterLabel: Record<string, string> = {
        all:     "TẤT CẢ key",
        free:    "tất cả key **FREE**",
        expired: "tất cả key **đã hết hạn**",
        locked:  "tất cả key **đã khóa**",
      };

      // Đếm số key sẽ bị xóa
      const all = await db.select().from(keysTable);
      const now = new Date();
      let targets: typeof all;
      switch (filter) {
        case "free":    targets = all.filter(k => k.tier === "free");                                         break;
        case "expired": targets = all.filter(k => k.isActive && k.expiresAt && k.expiresAt < now);           break;
        case "locked":  targets = all.filter(k => !k.isActive);                                               break;
        default:        targets = all;
      }

      if (targets.length === 0) {
        await interaction.editReply(`📭 Không có key nào thuộc nhóm **${filterLabel[filter] ?? filter}** để xóa.`);
        return;
      }

      // Hiển thị cảnh báo + nút xác nhận
      const confirmEmbed = new EmbedBuilder()
        .setColor(0xff1744)
        .setTitle("⚠️  XÁC NHẬN XÓA HÀNG LOẠT KEY")
        .setDescription(
          `Bạn sắp xóa **${targets.length}** ${filterLabel[filter] ?? filter}.\n\n` +
          `> ❌ Hành động này **KHÔNG THỂ HOÀN TÁC**.\n` +
          `> Tất cả thiết bị liên kết với các key này cũng sẽ bị xóa.\n\n` +
          `Nhấn **✅ Xác nhận** để tiếp tục, hoặc **❌ Hủy** để thoát.`,
        )
        .addFields({ name: "🔢 Số key sẽ xóa", value: `${targets.length}`, inline: true })
        .setFooter({ text: "Lệnh hết hạn sau 30 giây nếu không có phản hồi" })
        .setTimestamp();

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("xoatatkey:confirm")
          .setLabel("✅  Xác nhận xóa")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId("xoatatkey:cancel")
          .setLabel("❌  Hủy")
          .setStyle(ButtonStyle.Secondary),
      );

      const msg = await interaction.editReply({ embeds: [confirmEmbed], components: [row] });

      // Đợi người dùng bấm nút (30 giây)
      const collector = msg.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 30_000,
        max: 1,
      });

      collector.on("collect", async (btn: ButtonInteraction) => {
        if (btn.user.id !== interaction.user.id) {
          await btn.reply({ content: "❌ Bạn không thể xác nhận lệnh này.", flags: 64 });
          return;
        }

        if (btn.customId === "xoatatkey:cancel") {
          const cancelEmbed = new EmbedBuilder()
            .setColor(0x607d8b)
            .setTitle("↩️ Đã hủy")
            .setDescription("Không có key nào bị xóa.")
            .setTimestamp();
          await btn.update({ embeds: [cancelEmbed], components: [] });
          return;
        }

        // Xác nhận — thực hiện xóa
        await btn.deferUpdate();

        const targetIds = targets.map(k => k.id);

        // Xóa thiết bị liên kết trước, sau đó xóa key
        let deletedDevices = 0;
        for (const id of targetIds) {
          const devs = await db.delete(devicesTable).where(eq(devicesTable.keyId, id)).returning();
          deletedDevices += devs.length;
        }
        for (const id of targetIds) {
          await db.delete(keysTable).where(eq(keysTable.id, id));
        }

        const doneEmbed = new EmbedBuilder()
          .setColor(0xff1744)
          .setTitle("🗑️ Xóa hàng loạt hoàn tất")
          .setDescription(`Đã xóa **${targets.length}** ${filterLabel[filter] ?? filter}.`)
          .addFields(
            { name: "🗝️ Key đã xóa",       value: `${targets.length}`,  inline: true },
            { name: "📱 Thiết bị đã xóa",   value: `${deletedDevices}`,  inline: true },
          )
          .setFooter({ text: `Thực hiện bởi ${interaction.user.tag}` })
          .setTimestamp();

        await interaction.editReply({ embeds: [doneEmbed], components: [] });
      });

      collector.on("end", async (collected) => {
        if (collected.size === 0) {
          // Hết thời gian, vô hiệu hóa nút
          const timeoutEmbed = new EmbedBuilder()
            .setColor(0x607d8b)
            .setTitle("⏰ Hết thời gian xác nhận")
            .setDescription("Lệnh đã bị hủy do không có phản hồi trong 30 giây.")
            .setTimestamp();
          await interaction.editReply({ embeds: [timeoutEmbed], components: [] }).catch(() => {});
        }
      });
    }

    // ── /goyphan ─────────────────────────────────────────────────────────────
    else if (cmd === "goyphan") {
      const filter = interaction.options.getString("loai") ?? "all";

      const all = await db.select().from(feedbacksTable).orderBy(feedbacksTable.createdAt);
      const rows = filter === "all" ? all : all.filter(f => f.type === filter);

      if (rows.length === 0) {
        await interaction.editReply("📭 Chưa có phản hồi nào.");
        return;
      }

      const typeIcon: Record<string, string> = { bug: "🐛", feedback: "⭐", contact: "💬" };
      const lines = rows.slice(0, 20).map((f, i) => {
        const stars = f.stars > 0 ? "⭐".repeat(f.stars) : "–";
        const contact = f.contact ? ` · 📧 ${f.contact}` : "";
        return `**${i + 1}. ${typeIcon[f.type] ?? "📩"} [${f.type.toUpperCase()}]** ${f.title}\n> ${f.message.slice(0, 120)}${f.message.length > 120 ? "…" : ""}\n> ${stars}${contact}`;
      });

      const embed = new EmbedBuilder()
        .setColor(0x00e5ff)
        .setTitle(`📋 Báo lỗi & Góp ý (${rows.length} mục)`)
        .setDescription(lines.join("\n\n"))
        .setFooter({ text: `Hiển thị ${Math.min(20, rows.length)}/${rows.length} mục · Lọc: ${filter}` })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    }

    // ── /thongbaodaybp ───────────────────────────────────────────────────────
    else if (cmd === "thongbaodaybp") {
      const title = interaction.options.getString("tieude", true);
      const body  = interaction.options.getString("noidung", true);

      // Kiểm tra cấu hình FCM
      if (!isFcmConfigured()) {
        await interaction.editReply(
          "⚠️ **FIREBASE_SERVICE_ACCOUNT_JSON** chưa được cấu hình trên server.\n" +
          "Vào Firebase Console → Project settings → Service accounts → Generate new private key → đặt vào biến môi trường `FIREBASE_SERVICE_ACCOUNT_JSON`."
        );
        return;
      }

      // Lấy tất cả FCM token
      const rows = await db.select({ fcmToken: fcmTokensTable.fcmToken }).from(fcmTokensTable);

      if (rows.length === 0) {
        await interaction.editReply(
          "📭 Chưa có thiết bị nào đăng ký nhận push notification.\n" +
          "Người dùng cần **cài app → đăng nhập key** để token được đăng ký tự động."
        );
        return;
      }

      const allTokens = rows.map(r => r.fcmToken);

      // Gửi qua FCM v1 API
      const result = await sendFcmPush(allTokens, title, body);

      // Dọn token hết hạn khỏi DB
      if (result.invalidTokens.length > 0) {
        await db.delete(fcmTokensTable)
          .where(inArray(fcmTokensTable.fcmToken, result.invalidTokens))
          .catch(() => {});
      }

      const embed = new EmbedBuilder()
        .setColor(result.sent > 0 ? 0x00e676 : 0xff5722)
        .setTitle("📲 Push Notification Đã Gửi")
        .addFields(
          { name: "📌 Tiêu đề",          value: title,                    inline: false },
          { name: "📝 Nội dung",          value: body,                     inline: false },
          { name: "📱 Tổng thiết bị",     value: `${result.total}`,        inline: true  },
          { name: "✅ Gửi thành công",    value: `${result.sent}`,         inline: true  },
          { name: "❌ Thất bại",          value: `${result.failed}`,       inline: true  },
          ...(result.invalidTokens.length > 0
            ? [{ name: "🗑️ Token đã xóa", value: `${result.invalidTokens.length} token hết hạn`, inline: true }]
            : []),
          ...(result.error
            ? [{ name: "⚠️ Lỗi", value: result.error, inline: false }]
            : []),
        )
        .setFooter({ text: `Gửi bởi ${interaction.user.tag}` })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    }


    // ── /chatchapnhan ─────────────────────────────────────────────────────────
    else if (cmd === "chatchapnhan") {
      const sessionId = interaction.options.getInteger("id", true);
      const adminUser = interaction.user;
      const adminAvatar = adminUser.avatarURL({ size: 128 }) ?? "";
      const adminName = adminUser.displayName || adminUser.username;

      await db.execute(
        sql`UPDATE chat_sessions SET status='accepted', admin_name=${adminName}, admin_avatar=${adminAvatar}, admin_online=true, updated_at=NOW() WHERE id=${sessionId}`
      );
      await db.execute(
        sql`INSERT INTO chat_messages (session_id, sender, content, type) VALUES (${sessionId}, 'admin', ${"✅ Admin " + adminName + " đã chấp nhận trò chuyện! Xin chào bạn, tôi sẽ hỗ trợ bạn ngay."}, 'text')`
      );

      const embed = new EmbedBuilder()
        .setColor(0x00e676)
        .setTitle("✅ Đã chấp nhận phiên chat #" + sessionId)
        .setDescription(`Admin **${adminName}** đã kết nối với người dùng. Dùng /chatra ${sessionId} <tin nhắn> để trả lời.`)
        .setThumbnail(adminAvatar || null)
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    }

    // ── /chatra ───────────────────────────────────────────────────────────────
    else if (cmd === "chatra") {
      const sessionId = interaction.options.getInteger("id", true);
      const message   = interaction.options.getString("tinhnhan", true);
      const adminName = interaction.user.displayName || interaction.user.username;

      await db.execute(
        sql`INSERT INTO chat_messages (session_id, sender, content, type) VALUES (${sessionId}, 'admin', ${message}, 'text')`
      );
      await db.execute(
        sql`UPDATE chat_sessions SET updated_at=NOW() WHERE id=${sessionId}`
      );

      const embed = new EmbedBuilder()
        .setColor(0x1a90ff)
        .setTitle("💬 Đã gửi tin nhắn - Session #" + sessionId)
        .addFields({ name: "👤 Admin", value: adminName, inline: true })
        .addFields({ name: "📝 Nội dung", value: message, inline: false })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    }

    // ── /chatguianh ───────────────────────────────────────────────────────────
    else if (cmd === "chatguianh") {
      const sessionId = interaction.options.getInteger("id", true);
      const imageUrl  = interaction.options.getString("url", true);

      await db.execute(
        sql`INSERT INTO chat_messages (session_id, sender, content, type, image_data) VALUES (${sessionId}, 'admin', '[Hình ảnh từ Admin]', 'image', ${imageUrl})`
      );
      await db.execute(
        sql`UPDATE chat_sessions SET updated_at=NOW() WHERE id=${sessionId}`
      );

      const embed = new EmbedBuilder()
        .setColor(0x9c27b0)
        .setTitle("🖼️ Đã gửi ảnh - Session #" + sessionId)
        .setImage(imageUrl)
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    }

    // ── /chatthoat ────────────────────────────────────────────────────────────
    else if (cmd === "chatthoat") {
      const sessionId = interaction.options.getInteger("id", true);

      await db.execute(
        sql`INSERT INTO chat_messages (session_id, sender, content, type) VALUES (${sessionId}, 'bot', '❌ Admin đã kết thúc phiên trò chuyện. Cảm ơn bạn đã liên hệ! Nếu cần hỗ trợ thêm hãy bắt đầu cuộc trò chuyện mới.', 'text')`
      );
      await db.execute(
        sql`UPDATE chat_sessions SET status='closed', admin_online=false, updated_at=NOW() WHERE id=${sessionId}`
      );

      const embed = new EmbedBuilder()
        .setColor(0xff5722)
        .setTitle("🚪 Đã đóng phiên chat #" + sessionId)
        .setDescription("Người dùng đã được thông báo phiên chat kết thúc.")
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    }

    // ── /chatdanhsach ─────────────────────────────────────────────────────────
    else if (cmd === "chatdanhsach") {
      const result = await db.execute(
        sql`SELECT id, device_id, email, display_name, status, created_at FROM chat_sessions WHERE status IN ('pending','accepted') ORDER BY updated_at DESC LIMIT 20`
      );
      const rows = (result as any).rows ?? [];

      if (rows.length === 0) {
        await interaction.editReply("📭 Không có phiên chat nào đang chờ hoặc hoạt động.");
        return;
      }

      const lines = rows.map((r: any) =>
        `**#${r.id}** — ${r.status === "pending" ? "⏳ CHỜ" : "✅ ĐANG CHAT"}\n` +
        `📧 ${r.email}\n📱 ${String(r.device_id ?? "").slice(0, 14)}…\n` +
        `💡 Dùng /chatchapnhan ${r.id} để chấp nhận`
      );

      const embed = new EmbedBuilder()
        .setColor(0x00bcd4)
        .setTitle(`💬 Phiên chat đang hoạt động (${rows.length})`)
        .setDescription(lines.join("\n\n"))
        .setFooter({ text: "Dùng /chatchapnhan <id> · /chatra <id> <msg> · /chatthoat <id>" })
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

// ════════════════════════════════════════════════════════════════════════════
// DISCORD LOG CHANNEL — gửi thông báo tự động về kênh server
// ════════════════════════════════════════════════════════════════════════════

const LOG_CHANNEL_ID = process.env.DISCORD_LOG_CHANNEL_ID ?? "";
const CHAT_CHANNEL_ID = process.env.DISCORD_CHAT_CHANNEL_ID ?? "";

// Singleton REST client dùng riêng cho log channel (tách biệt với bot slash-command)
let _logRest: REST | null = null;
function getLogRest(): REST | null {
  if (!TOKEN || !LOG_CHANNEL_ID) return null;
  if (!_logRest) _logRest = new REST({ version: "10" }).setToken(TOKEN);
  return _logRest;
}

export type DiscordLogEvent =
  | "KEY_FREE_CREATED"   // Web tạo key free thành công (claim-free)
  | "KEY_LOGIN"          // App đăng nhập key (validate)
  | "KEY_ONLINE"         // Thiết bị vừa online (heartbeat sau offline)
  | "KEY_OFFLINE"        // Thiết bị logout
  | "KEY_EXPIRED_HB"     // Key hết hạn được phát hiện qua heartbeat
  | "KEY_REVOKED_HB"     // Key bị thu hồi được phát hiện qua heartbeat
  | "GOOGLE_LOGIN";      // Người dùng đăng nhập Google thành công từ app

export interface DiscordLogPayload {
  event:          DiscordLogEvent;
  key?:           string;
  tier?:          string;
  deviceName?:    string;
  deviceId?:      string;
  deviceOs?:      string;
  deviceSdk?:     string | number;
  deviceRam?:     string;
  expiresAt?:     Date | null;
  isNewDevice?:   boolean;
  label?:         string;
  note?:          string;
  googleEmail?:   string;   // Email tài khoản Google (khi event=GOOGLE_LOGIN)
  googleName?:    string;   // Tên tài khoản Google
  googlePhotoUrl?: string;  // URL ảnh đại diện Google
  // ── Feedback-specific ──────────────────────────────────────────────────────
  title?:     string;   // Tiêu đề feedback (dùng làm embed title override)
  contact?:   string;   // Email / Facebook người dùng
  deviceKey?: string;   // Key người dùng
  starsStr?:  string;   // Chuỗi sao đánh giá "⭐⭐⭐ (3/5)"
  savedId?:   number;   // ID đã lưu trong DB
}

function _evMeta(ev: DiscordLogEvent): { color: number; icon: string; title: string } {
  switch (ev) {
    case "KEY_FREE_CREATED": return { color: 0x00C853, icon: "🎁", title: "Key Miễn Phí Đã Tạo" };
    case "KEY_LOGIN":        return { color: 0x2196F3, icon: "🔑", title: "Đăng Nhập Key" };
    case "KEY_ONLINE":       return { color: 0x00BFA5, icon: "🟢", title: "Thiết Bị Online" };
    case "KEY_OFFLINE":      return { color: 0x607D8B, icon: "🔴", title: "Thiết Bị Offline" };
    case "KEY_EXPIRED_HB":   return { color: 0xFF5722, icon: "⛔", title: "Key Hết Hạn (Phát Hiện)" };
    case "KEY_REVOKED_HB":   return { color: 0xF44336, icon: "🔒", title: "Key Bị Thu Hồi (Phát Hiện)" };
    case "GOOGLE_LOGIN":     return { color: 0x4285F4, icon: "🔵", title: "Đăng Nhập Google" };
    case "FEEDBACK":         return { color: 0x00E5FF, icon: "📩", title: "Phản Hồi Người Dùng" };
  }
}

function _fmtDate(d: Date | null | undefined): string {
  if (!d) return "Không giới hạn";
  return d.toLocaleDateString("vi-VN", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

/**
 * Gửi embed thông báo tự động vào kênh DISCORD_LOG_CHANNEL_ID.
 * Hàm không ném lỗi — lỗi chỉ được log ra console.
 */
export async function sendDiscordLog(payload: DiscordLogPayload): Promise<void> {
  const rest = getLogRest();
  if (!rest) return; // chưa cấu hình → bỏ qua

  const meta = _evMeta(payload.event);

  const fields: { name: string; value: string; inline: boolean }[] = [];

  if (payload.key) {
    fields.push({ name: "🗝️ Key", value: `\`${payload.key}\``, inline: false });
  }
  if (payload.tier) {
    const tierLabel = payload.tier === "vip" ? "👑 VIP" : "🆓 FREE";
    fields.push({ name: "⭐ Tier", value: tierLabel, inline: true });
  }
  if (payload.label) {
    fields.push({ name: "🏷️ Nhãn", value: payload.label, inline: true });
  }
  if (payload.deviceName) {
    fields.push({ name: "📱 Thiết bị", value: payload.deviceName, inline: true });
  }
  if (payload.deviceId) {
    const shortId = payload.deviceId.length > 22
      ? payload.deviceId.substring(0, 22) + "…"
      : payload.deviceId;
    fields.push({ name: "🆔 Device ID", value: `\`${shortId}\``, inline: false });
  }
  if (payload.deviceOs) {
    const osStr = `${payload.deviceOs}${payload.deviceSdk ? ` (SDK ${payload.deviceSdk})` : ""}`;
    fields.push({ name: "🤖 Hệ điều hành", value: osStr, inline: true });
  }
  if (payload.deviceRam) {
    fields.push({ name: "🧠 RAM", value: payload.deviceRam, inline: true });
  }
  if (payload.expiresAt !== undefined) {
    fields.push({ name: "⏰ Hết hạn", value: _fmtDate(payload.expiresAt), inline: true });
  }
  if (payload.isNewDevice !== undefined) {
    fields.push({ name: "🆕 Thiết bị mới", value: payload.isNewDevice ? "✅ Có" : "❌ Không", inline: true });
  }
  if (payload.note) {
    fields.push({ name: "📝 Ghi chú", value: payload.note, inline: false });
  }
  if (payload.googleName) {
    fields.push({ name: "👤 Google Name", value: payload.googleName, inline: true });
  }
  if (payload.googleEmail) {
    fields.push({ name: "📧 Google Email", value: payload.googleEmail, inline: true });
  }
  // ── Feedback fields ─────────────────────────────────────────────────────
  if (payload.starsStr) {
    fields.push({ name: "⭐ Đánh giá", value: payload.starsStr, inline: true });
  }
  if (payload.contact) {
    fields.push({ name: "📧 Liên hệ", value: payload.contact, inline: true });
  }
  if (payload.deviceKey) {
    fields.push({ name: "🗝️ Device Key", value: `\`${payload.deviceKey.slice(0, 20)}…\``, inline: true });
  }
  if (payload.savedId !== undefined) {
    fields.push({ name: "🆔 DB ID", value: `#${payload.savedId}`, inline: true });
  }

  const embed = {
    color:     meta.color,
    title:     payload.title ? `${meta.icon} ${payload.title}` : `${meta.icon} ${meta.title}`,
    fields,
    timestamp: new Date().toISOString(),
    footer:    { text: "Aujunpeak Monitor" },
  };

  try {
    await rest.post(Routes.channelMessages(LOG_CHANNEL_ID) as `/${string}`, {
      body: { embeds: [embed] },
    });
  } catch (err) {
    logger.warn({ err }, "sendDiscordLog: failed to post to log channel");
  }
}


// ════════════════════════════════════════════════════════════════════════════
// CHAT DISCORD INTEGRATION — gửi tin nhắn chat lên kênh Discord
// ════════════════════════════════════════════════════════════════════════════

export interface ChatDiscordPayload {
  sessionId: number;
  deviceId: string;
  email: string;
  displayName: string;
  content: string;
  imageData?: string;
  type?: string;
  isNewSession?: boolean;
}

/**
 * Gửi tin nhắn chat của người dùng lên kênh Discord dành cho admin.
 *
 * - Text message  → embed bình thường
 * - Image (base64) → gửi kèm file attachment để admin thấy ảnh thật
 * - Image (URL)    → embed image preview
 *
 * Admin trả lời bằng: /chatra <sessionId> <message>
 */
export async function sendChatMessageToDiscord(payload: ChatDiscordPayload): Promise<void> {
  const rest = getLogRest();
  if (!rest || !CHAT_CHANNEL_ID) return;

  const shortDeviceId = payload.deviceId.length > 18
    ? payload.deviceId.substring(0, 18) + "…"
    : payload.deviceId;

  const isImageMsg  = payload.type === "image" && payload.imageData;
  const isBase64Img = isImageMsg &&
    !payload.imageData!.startsWith("http://") &&
    !payload.imageData!.startsWith("https://");
  const isUrlImg    = isImageMsg && !isBase64Img;

  const footerText = payload.isNewSession
    ? `Dùng /chatchapnhan ${payload.sessionId} để chấp nhận`
    : `/chatra ${payload.sessionId} <tin nhắn> · /chatthoat ${payload.sessionId}`;

  const contentField = isImageMsg
    ? { name: "🖼️ Loại",    value: "Hình ảnh",                     inline: true }
    : { name: "💬 Nội dung", value: payload.content || "—",         inline: false };

  const fields: { name: string; value: string; inline: boolean }[] = [
    { name: "🆔 Session", value: `#${payload.sessionId}`, inline: true },
    { name: "📧 Email",   value: payload.email,            inline: true },
    { name: "👤 Tên",     value: payload.displayName || "—", inline: true },
    { name: "📱 Device",  value: `\`${shortDeviceId}\``,   inline: false },
    contentField,
  ];

  const embed: Record<string, unknown> = {
    color: payload.isNewSession ? 0x00bcd4 : (isImageMsg ? 0x9c27b0 : 0x1a90ff),
    title: payload.isNewSession
      ? `🆕 Yêu cầu chat mới từ ${payload.displayName || payload.email}`
      : isImageMsg
        ? `🖼️ Ảnh từ ${payload.displayName || payload.email}`
        : `💬 Tin nhắn từ ${payload.displayName || payload.email}`,
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: footerText },
  };

  // Nếu imageData là URL, nhúng preview vào embed
  if (isUrlImg) {
    embed["image"] = { url: payload.imageData };
  }

  // Nếu imageData là URL, nhúng vào embed luôn không cần đọc file attachment
  if (isBase64Img) {
    embed["image"] = { url: "attachment://user_image.jpg" };
  }

  try {
    if (isBase64Img) {
      // Gửi ảnh dưới dạng file attachment để admin thấy ảnh thật
      const buffer = Buffer.from(payload.imageData!, "base64");
      await rest.post(Routes.channelMessages(CHAT_CHANNEL_ID) as `/${string}`, {
        body: { embeds: [embed] },
        files: [
          {
            name: "user_image.jpg",
            data: buffer,
            contentType: "image/jpeg",
          },
        ],
      });
    } else {
      await rest.post(Routes.channelMessages(CHAT_CHANNEL_ID) as `/${string}`, {
        body: { embeds: [embed] },
      });
    }
  } catch (err) {
    logger.warn({ err }, "sendChatMessageToDiscord: failed to post");
    // Fallback: thử gửi embed đơn giản không kèm file
    try {
      const fallbackEmbed = { ...embed };
      delete (fallbackEmbed as Record<string, unknown>)["image"];
      fallbackEmbed["description"] = isImageMsg ? "📷 *[Người dùng gửi hình ảnh]*" : undefined;
      await rest.post(Routes.channelMessages(CHAT_CHANNEL_ID) as `/${string}`, {
        body: { embeds: [fallbackEmbed] },
      });
    } catch (err2) {
      logger.warn({ err: err2 }, "sendChatMessageToDiscord: fallback also failed");
    }
  }
}
