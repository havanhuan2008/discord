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
import { db, keysTable, devicesTable, notificationsTable, notificationReadsTable, feedbacksTable, fcmTokensTable, chatSessionsTable, chatMessagesTable, appConfigTable } from "../db/index.js";
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

  // ── Force Update ──────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setName("update")
    .setDescription("🔄 Bật/tắt chế độ force update cho app")
    .addStringOption(o =>
      o.setName("trang_thai")
        .setDescription("Bật hoặc tắt force update")
        .setRequired(true)
        .addChoices(
          { name: "🟢 Bật (on) — bắt buộc cập nhật", value: "on"  },
          { name: "🔴 Tắt (off) — cho vào app bình thường", value: "off" },
        ))
    .addIntegerOption(o =>
      o.setName("phien_ban")
        .setDescription("Version code tối thiểu bắt buộc (mặc định: giữ nguyên hiện tại)")
        .setRequired(false))
    .toJSON(),

  new SlashCommandBuilder()
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setName("setdownloadurl")
    .setDescription("🔗 Đặt link tải APK mới (hiển thị trên màn hình force update)")
    .addStringOption(o =>
      o.setName("url")
        .setDescription("URL tải APK mới (vd: https://example.com/app-new.apk)")
        .setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setName("statusupdate")
    .setDescription("📊 Xem trạng thái hiện tại của force update")
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

// ── Helper: đọc/ghi app_config ───────────────────────────────────────────────
async function getAppConfig(): Promise<Record<string, string>> {
  const configs = await db.select().from(appConfigTable);
  const map: Record<string, string> = {};
  for (const c of configs) map[c.key] = c.value;
  return map;
}

async function setAppConfig(key: string, value: string): Promise<void> {
  await db
    .insert(appConfigTable)
    .values({ key, value })
    .onConflictDoUpdate({ target: appConfigTable.key, set: { value } });
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
          tier,
          maxDevices: maxDev,
          expiresAt,
          discordUserId: interaction.user.id,
        }).returning();
      } catch (dbErr: any) {
        if (dbErr?.code === "23505") {
          await interaction.editReply(`❌ Key \`${key}\` đã tồn tại. Dùng lệnh không có --key để tự sinh ngẫu nhiên.`);
        } else {
          throw dbErr;
        }
        return;
      }

      const exp = expiresAt ? formatDate(expiresAt) : "Vĩnh viễn";
      const embed = new EmbedBuilder()
        .setColor(tier === "vip" ? 0xffd700 : 0x00e676)
        .setTitle(`🎉 Đã tạo key ${tierBadge(tier)}`)
        .addFields(
          { name: "🗝️ Key",          value: `\`${key}\``,    inline: false },
          { name: "📅 Hết hạn",       value: exp,             inline: true  },
          { name: "📱 Max thiết bị",  value: `${maxDev}`,     inline: true  },
          { name: "🏷️ Nhãn",          value: label || "—",    inline: true  },
          { name: "📝 Ghi chú",       value: note  || "—",    inline: false },
        )
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });

    // ── /nangcap ──────────────────────────────────────────────────────────────
    } else if (cmd === "nangcap") {
      const keyStr   = interaction.options.getString("key", true).trim().toUpperCase();
      const tierInput = interaction.options.getString("loai", true).toLowerCase();
      if (!["free", "vip"].includes(tierInput)) {
        await interaction.editReply("❌ Tier phải là `free` hoặc `vip`.");
        return;
      }
      const record = await findKey(keyStr);
      if (!record) { await interaction.editReply(`❌ Không tìm thấy key \`${keyStr}\`.`); return; }
      await db.update(keysTable).set({ tier: tierInput }).where(eq(keysTable.key, keyStr));
      const embed = new EmbedBuilder()
        .setColor(tierInput === "vip" ? 0xffd700 : 0x00e676)
        .setTitle(`✅ Đã cập nhật tier`)
        .addFields(
          { name: "🗝️ Key",  value: `\`${keyStr}\``,    inline: false },
          { name: "⭐ Tier", value: tierBadge(tierInput), inline: true  },
        ).setTimestamp();
      await interaction.editReply({ embeds: [embed] });

    // ── /xemkey ───────────────────────────────────────────────────────────────
    } else if (cmd === "xemkey") {
      const keyStr = interaction.options.getString("key", true).trim().toUpperCase();
      const record = await findKey(keyStr);
      if (!record) { await interaction.editReply(`❌ Không tìm thấy key \`${keyStr}\`.`); return; }
      const devs = await db.select().from(devicesTable).where(eq(devicesTable.keyId, record.id));
      const exp  = record.expiresAt ? formatDate(record.expiresAt) : "Vĩnh viễn";
      const embed = new EmbedBuilder()
        .setColor(record.isActive ? 0x00e676 : 0xff5252)
        .setTitle(`🗝️ Chi tiết key`)
        .addFields(
          { name: "Key",           value: `\`${record.key}\``,                    inline: false },
          { name: "Trạng thái",    value: statusEmoji(record) + " " + (record.isActive ? "Hoạt động" : "Đã khóa"), inline: true },
          { name: "Tier",          value: tierBadge(record.tier),                  inline: true  },
          { name: "Hết hạn",       value: exp,                                    inline: true  },
          { name: "Nhãn",          value: record.label || "—",                    inline: true  },
          { name: "Max thiết bị",  value: `${record.maxDevices}`,                 inline: true  },
          { name: "Đang đăng nhập",value: `${devs.length}`,                       inline: true  },
          { name: "Ghi chú",       value: record.note || "—",                     inline: false },
          { name: "Tạo lúc",       value: formatDate(record.createdAt),            inline: true  },
        ).setTimestamp();
      await interaction.editReply({ embeds: [embed] });

    // ── /danhsachkey ─────────────────────────────────────────────────────────
    } else if (cmd === "danhsachkey") {
      const filter   = interaction.options.getString("loc") ?? "all";
      const allKeys  = await fetchKeysForFilter(filter);
      const total    = allKeys.length;
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      const label    = filterDisplayLabel(filter);
      let page = 0;
      const embed = buildKeyListEmbed(allKeys, page, totalPages, total, label);

      if (totalPages <= 1) {
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      const prefix = `keylist:${Date.now()}`;
      const row    = paginationRow(page, totalPages, prefix);
      const msg    = await interaction.editReply({ embeds: [embed], components: [row] });

      const collector = msg.createMessageComponentCollector({
        componentType: ComponentType.Button,
        filter: (btn: ButtonInteraction) => btn.user.id === interaction.user.id && btn.customId.startsWith(prefix),
        time: 5 * 60_000,
      });

      collector.on("collect", async (btn: ButtonInteraction) => {
        const [, action] = btn.customId.split(":");
        if      (action === "first") page = 0;
        else if (action === "prev")  page = Math.max(0, page - 1);
        else if (action === "next")  page = Math.min(totalPages - 1, page + 1);
        else if (action === "last")  page = totalPages - 1;
        const newEmbed = buildKeyListEmbed(allKeys, page, totalPages, total, label);
        const newRow   = paginationRow(page, totalPages, prefix);
        await btn.update({ embeds: [newEmbed], components: [newRow] });
      });
      collector.on("end", async () => {
        try { await interaction.editReply({ components: [] }); } catch { /* ignore */ }
      });

    // ── /suakey ───────────────────────────────────────────────────────────────
    } else if (cmd === "suakey") {
      const keyStr  = interaction.options.getString("key", true).trim().toUpperCase();
      const nhan    = interaction.options.getString("nhan");
      const ghichu  = interaction.options.getString("ghichu");
      const thietbi = interaction.options.getInteger("thietbi");

      const record = await findKey(keyStr);
      if (!record) { await interaction.editReply(`❌ Không tìm thấy key \`${keyStr}\`.`); return; }
      if (!nhan && !ghichu && thietbi == null) {
        await interaction.editReply("❌ Phải chỉ định ít nhất một trường cần sửa (--nhan, --ghichu, --thietbi).");
        return;
      }

      const patch: Partial<{ label: string; note: string; maxDevices: number }> = {};
      if (nhan    != null) patch.label      = nhan;
      if (ghichu  != null) patch.note       = ghichu;
      if (thietbi != null) patch.maxDevices = thietbi;

      await db.update(keysTable).set(patch).where(eq(keysTable.key, keyStr));
      const embed = new EmbedBuilder()
        .setColor(0x2196f3)
        .setTitle("✅ Đã cập nhật key")
        .addFields(
          { name: "🗝️ Key",          value: `\`${keyStr}\``,                         inline: false },
          { name: "🏷️ Nhãn",          value: patch.label      ?? record.label ?? "—", inline: true  },
          { name: "📝 Ghi chú",       value: patch.note       ?? record.note  ?? "—", inline: true  },
          { name: "📱 Max thiết bị",  value: String(patch.maxDevices ?? record.maxDevices),          inline: true  },
        ).setTimestamp();
      await interaction.editReply({ embeds: [embed] });

    // ── /khoakey ─────────────────────────────────────────────────────────────
    } else if (cmd === "khoakey") {
      const keyStr = interaction.options.getString("key", true).trim().toUpperCase();
      const record = await findKey(keyStr);
      if (!record) { await interaction.editReply(`❌ Không tìm thấy key \`${keyStr}\`.`); return; }
      await db.update(keysTable).set({ isActive: false }).where(eq(keysTable.key, keyStr));
      const embed = new EmbedBuilder()
        .setColor(0xff5252)
        .setTitle("🔒 Đã khóa key")
        .addFields({ name: "🗝️ Key", value: `\`${keyStr}\``, inline: false })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });

    // ── /mokey ───────────────────────────────────────────────────────────────
    } else if (cmd === "mokey") {
      const keyStr = interaction.options.getString("key", true).trim().toUpperCase();
      const record = await findKey(keyStr);
      if (!record) { await interaction.editReply(`❌ Không tìm thấy key \`${keyStr}\`.`); return; }
      await db.update(keysTable).set({ isActive: true }).where(eq(keysTable.key, keyStr));
      const embed = new EmbedBuilder()
        .setColor(0x00e676)
        .setTitle("🔓 Đã mở khóa key")
        .addFields({ name: "🗝️ Key", value: `\`${keyStr}\``, inline: false })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });

    // ── /xoakey ───────────────────────────────────────────────────────────────
    } else if (cmd === "xoakey") {
      const keyStr = interaction.options.getString("key", true).trim().toUpperCase();
      const record = await findKey(keyStr);
      if (!record) { await interaction.editReply(`❌ Không tìm thấy key \`${keyStr}\`.`); return; }
      // Xóa device liên quan trước
      await db.delete(devicesTable).where(eq(devicesTable.keyId, record.id));
      await db.delete(keysTable).where(eq(keysTable.key, keyStr));
      const embed = new EmbedBuilder()
        .setColor(0xf44336)
        .setTitle("🗑️ Đã xóa key vĩnh viễn")
        .addFields({ name: "🗝️ Key", value: `\`${keyStr}\``, inline: false })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });

    // ── /giahan ───────────────────────────────────────────────────────────────
    } else if (cmd === "giahan") {
      const keyStr = interaction.options.getString("key", true).trim().toUpperCase();
      const days   = interaction.options.getInteger("ngay", true);
      const record = await findKey(keyStr);
      if (!record) { await interaction.editReply(`❌ Không tìm thấy key \`${keyStr}\`.`); return; }

      const base     = record.expiresAt && record.expiresAt > new Date() ? record.expiresAt : new Date();
      const newExpiry = new Date(base.getTime() + days * 86400000);
      await db.update(keysTable).set({ expiresAt: newExpiry }).where(eq(keysTable.key, keyStr));
      const embed = new EmbedBuilder()
        .setColor(0x00bfa5)
        .setTitle("📅 Đã gia hạn key")
        .addFields(
          { name: "🗝️ Key",     value: `\`${keyStr}\``,      inline: false },
          { name: "➕ Thêm",    value: `${days} ngày`,         inline: true  },
          { name: "📅 Mới hết hạn", value: formatDate(newExpiry), inline: true },
        ).setTimestamp();
      await interaction.editReply({ embeds: [embed] });

    // ── /thietbi ─────────────────────────────────────────────────────────────
    } else if (cmd === "thietbi") {
      const keyStr = interaction.options.getString("key", true).trim().toUpperCase();
      const record = await findKey(keyStr);
      if (!record) { await interaction.editReply(`❌ Không tìm thấy key \`${keyStr}\`.`); return; }
      const devs = await db.select().from(devicesTable)
        .where(eq(devicesTable.keyId, record.id))
        .orderBy(devicesTable.id);
      if (devs.length === 0) {
        await interaction.editReply(`📭 Key \`${keyStr}\` chưa có thiết bị nào đăng nhập.`);
        return;
      }
      const lines = devs.map((d, i) =>
        `**${i + 1}.** ${d.isActive ? "🟢" : "⚪"} ${d.deviceName} · \`${d.deviceId.slice(0, 16)}…\` · Lần cuối: ${formatDate(d.lastSeen)}${d.isActive ? "" : " · đã đăng xuất (vẫn chiếm slot)"}`
      );
      const embed = new EmbedBuilder()
        .setColor(0x7c4dff)
        .setTitle(`📱 Thiết bị của key \`${keyStr}\``)
        .setDescription(lines.join("\n"))
        .setFooter({ text: "Dùng /xoathietbi <key> <stt> để xóa" })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });

    // ── /xoathietbi ─────────────────────────────────────────────────────────
    } else if (cmd === "xoathietbi") {
      const keyStr = interaction.options.getString("key", true).trim().toUpperCase();
      const stt    = interaction.options.getInteger("stt", true);
      const record = await findKey(keyStr);
      if (!record) { await interaction.editReply(`❌ Không tìm thấy key \`${keyStr}\`.`); return; }
      const devs = await db.select().from(devicesTable)
        .where(eq(devicesTable.keyId, record.id))
        .orderBy(devicesTable.id);
      const idx  = stt - 1;
      if (idx < 0 || idx >= devs.length) {
        await interaction.editReply(`❌ STT ${stt} không hợp lệ (key có ${devs.length} thiết bị).`);
        return;
      }
      const target = devs[idx];
      // Xóa vĩnh viễn record để giải phóng slot thiết bị (soft-logout không đủ vì
      // slot bị giữ mãi cho tới khi admin xóa hẳn — xem README_BUGFIX_DEVICE_LIMIT.md)
      await db.delete(devicesTable).where(eq(devicesTable.id, target.id));
      const embed = new EmbedBuilder()
        .setColor(0xff9800)
        .setTitle("🗑️ Đã xóa thiết bị")
        .addFields(
          { name: "🗝️ Key",    value: `\`${keyStr}\``,      inline: false },
          { name: "📱 Device", value: target.deviceName,     inline: true  },
          { name: "🆔 ID",     value: `\`${target.deviceId.slice(0, 16)}…\``, inline: true },
        ).setTimestamp();
      await interaction.editReply({ embeds: [embed] });

    // ── /thongke ─────────────────────────────────────────────────────────────
    } else if (cmd === "thongke") {
      const [allKeys, allDevs] = await Promise.all([
        db.select().from(keysTable),
        db.select().from(devicesTable),
      ]);
      const now     = new Date();
      const active  = allKeys.filter(k => k.isActive && !(k.expiresAt && k.expiresAt < now));
      const expired = allKeys.filter(k => k.expiresAt && k.expiresAt < now);
      const locked  = allKeys.filter(k => !k.isActive);
      const vip     = allKeys.filter(k => k.tier === "vip");
      const free    = allKeys.filter(k => k.tier === "free");
      const embed = new EmbedBuilder()
        .setColor(0x7c4dff)
        .setTitle("📊 Thống kê hệ thống")
        .addFields(
          { name: "🗝️ Tổng key",        value: `${allKeys.length}`,  inline: true },
          { name: "✅ Đang hoạt động",   value: `${active.length}`,   inline: true },
          { name: "⛔ Hết hạn",          value: `${expired.length}`,  inline: true },
          { name: "🔒 Đã khóa",          value: `${locked.length}`,   inline: true },
          { name: "👑 VIP",              value: `${vip.length}`,      inline: true },
          { name: "🆓 FREE",             value: `${free.length}`,     inline: true },
          { name: "📱 Tổng thiết bị",   value: `${allDevs.length}`,  inline: true },
        ).setTimestamp();
      await interaction.editReply({ embeds: [embed] });

    // ── /online ──────────────────────────────────────────────────────────────
    } else if (cmd === "online") {
      const result = await db.execute(
        sql`SELECT d.device_id, d.device_name, k."key" AS key, k.tier AS tier,
                   d.device_os, d.device_sdk, d.device_ram, d.last_seen
            FROM devices d
            JOIN keys k ON k.id = d.key_id
            WHERE d.is_active = true
              AND d.last_seen > NOW() - INTERVAL '5 minutes'
            ORDER BY d.last_seen DESC
            LIMIT 30`
      );
      const rows = (result as any).rows ?? [];
      if (rows.length === 0) {
        await interaction.editReply("📭 Không có thiết bị nào online trong 5 phút gần nhất.");
        return;
      }
      const lines = rows.map((r: any, i: number) => {
        const diffMs  = Date.now() - new Date(r.last_seen).getTime();
        const diffMin = Math.floor(diffMs / 60_000);
        const ago     = diffMin === 0 ? "vừa xong" : `${diffMin} phút trước`;
        const osStr   = r.device_os ? ` · ${r.device_os}${r.device_sdk ? ` SDK${r.device_sdk}` : ""}` : "";
        const ramStr  = r.device_ram ? ` · 💾 ${r.device_ram}` : "";
        return `**${i + 1}.** 📱 ${r.device_name}${osStr}${ramStr}\n🗝️ \`${r.key}\` · ${tierBadge(r.tier)} · 🕒 ${ago}`;
      });
      const embed = new EmbedBuilder()
        .setColor(0x00bfa5)
        .setTitle(`🟢 Thiết bị online (${rows.length})`)
        .setDescription(lines.join("\n\n"))
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });

    // ── /thongbao ─────────────────────────────────────────────────────────────
    } else if (cmd === "thongbao") {
      const title  = interaction.options.getString("tieude", true);
      const body   = interaction.options.getString("noidung", true);
      const sentBy = interaction.user.username;
      const [record] = await db.insert(notificationsTable).values({ title, body, sentBy }).returning();
      const embed = new EmbedBuilder()
        .setColor(0xff9800)
        .setTitle("📢 Đã gửi thông báo")
        .addFields(
          { name: "📌 Tiêu đề", value: title,  inline: false },
          { name: "📝 Nội dung", value: body,  inline: false },
          { name: "🆔 ID",       value: `#${record.id}`, inline: true },
          { name: "👤 Gửi bởi", value: sentBy, inline: true },
        ).setTimestamp();
      await interaction.editReply({ embeds: [embed] });

    // ── /danhsachthongbao ─────────────────────────────────────────────────────
    } else if (cmd === "danhsachthongbao") {
      const allNotifs = await db.select().from(notificationsTable).orderBy(notificationsTable.createdAt);
      const total = allNotifs.length;
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      let page = 0;
      const embed = buildNotifListEmbed(allNotifs, page, totalPages, total);
      if (totalPages <= 1) {
        await interaction.editReply({ embeds: [embed] });
        return;
      }
      const prefix = `notiflist:${Date.now()}`;
      const row    = paginationRow(page, totalPages, prefix);
      const msg    = await interaction.editReply({ embeds: [embed], components: [row] });
      const collector = msg.createMessageComponentCollector({
        componentType: ComponentType.Button,
        filter: (btn: ButtonInteraction) => btn.user.id === interaction.user.id && btn.customId.startsWith(prefix),
        time: 5 * 60_000,
      });
      collector.on("collect", async (btn: ButtonInteraction) => {
        const [, action] = btn.customId.split(":");
        if      (action === "first") page = 0;
        else if (action === "prev")  page = Math.max(0, page - 1);
        else if (action === "next")  page = Math.min(totalPages - 1, page + 1);
        else if (action === "last")  page = totalPages - 1;
        const newEmbed = buildNotifListEmbed(allNotifs, page, totalPages, total);
        await btn.update({ embeds: [newEmbed], components: [paginationRow(page, totalPages, prefix)] });
      });
      collector.on("end", async () => {
        try { await interaction.editReply({ components: [] }); } catch { /* ignore */ }
      });

    // ── /xoathongbao ─────────────────────────────────────────────────────────
    } else if (cmd === "xoathongbao") {
      const id = interaction.options.getInteger("id", true);
      const [notif] = await db.select().from(notificationsTable).where(eq(notificationsTable.id, id));
      if (!notif) {
        await interaction.editReply(`❌ Không tìm thấy thông báo #${id}.`);
        return;
      }
      await db.delete(notificationReadsTable).where(eq(notificationReadsTable.notificationId, id));
      await db.delete(notificationsTable).where(eq(notificationsTable.id, id));
      const embed = new EmbedBuilder()
        .setColor(0xf44336)
        .setTitle("🗑️ Đã xóa thông báo")
        .addFields(
          { name: "🆔 ID",       value: `#${id}`,     inline: true  },
          { name: "📌 Tiêu đề", value: notif.title,   inline: false },
        ).setTimestamp();
      await interaction.editReply({ embeds: [embed] });

    // ── /xoatatthongbao ───────────────────────────────────────────────────────
    } else if (cmd === "xoatatthongbao") {
      const allNotifs = await db.select().from(notificationsTable);
      const count = allNotifs.length;
      if (count === 0) {
        await interaction.editReply("📭 Chưa có thông báo nào để xóa.");
        return;
      }
      await db.delete(notificationReadsTable);
      await db.delete(notificationsTable);
      const embed = new EmbedBuilder()
        .setColor(0xf44336)
        .setTitle("🗑️ Đã xóa tất cả thông báo")
        .addFields({ name: "📊 Số lượng", value: `${count}`, inline: true })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });

    // ── /xoatatkey ───────────────────────────────────────────────────────────
    } else if (cmd === "xoatatkey") {
      const filter = interaction.options.getString("loc") ?? "all";
      let allKeys = await fetchKeysForFilter(filter);
      const count = allKeys.length;

      if (count === 0) {
        await interaction.editReply("📭 Không có key nào phù hợp để xóa.");
        return;
      }

      // Xác nhận bằng buttons
      const rawLabel = filterDisplayLabel(filter).replace(/^·\s*/, "");
      const filterSuffix = rawLabel ? ` (${rawLabel})` : "";
      const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("bulk_confirm").setLabel(`⚠️ Xóa ${count} key`).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("bulk_cancel").setLabel("Hủy").setStyle(ButtonStyle.Secondary),
      );
      const msg = await interaction.editReply({
        content: `⚠️ **Xác nhận xóa ${count} key${filterSuffix}**?\nHành động này **không thể hoàn tác**.`,
        components: [confirmRow],
      });

      const collector = msg.createMessageComponentCollector({
        componentType: ComponentType.Button,
        filter: (btn: ButtonInteraction) => btn.user.id === interaction.user.id,
        time: 30_000,
        max: 1,
      });
      collector.on("collect", async (btn: ButtonInteraction) => {
        if (btn.customId === "bulk_confirm") {
          const ids    = allKeys.map(k => k.key);
          const keyIds = allKeys.map(k => k.id);
          await db.delete(devicesTable).where(inArray(devicesTable.keyId, keyIds));
          await db.delete(keysTable).where(inArray(keysTable.key, ids));
          await btn.update({ content: `✅ Đã xóa **${count} key** thành công.`, components: [] });
        } else {
          await btn.update({ content: "❌ Đã hủy.", components: [] });
        }
      });
      collector.on("end", async (_, reason) => {
        if (reason === "time") {
          try { await interaction.editReply({ content: "⏱️ Hết thời gian xác nhận.", components: [] }); } catch { /* ignore */ }
        }
      });

    // ── /goyphan ─────────────────────────────────────────────────────────────
    } else if (cmd === "goyphan") {
      const filterType = interaction.options.getString("loai") ?? "all";
      let feedbacks = await db.select().from(feedbacksTable).orderBy(feedbacksTable.createdAt);
      if (filterType !== "all") {
        feedbacks = feedbacks.filter((f: typeof feedbacksTable.$inferSelect) => f.type === filterType);
      }
      if (feedbacks.length === 0) {
        await interaction.editReply(`📭 Không có góp ý nào${filterType !== "all" ? ` loại \`${filterType}\`` : ""}.`);
        return;
      }
      const typeLabel: Record<string, string> = { bug: "🐛 Báo lỗi", feedback: "💡 Góp ý", contact: "📞 Liên hệ" };
      const lines = feedbacks.slice(0, 15).map((f: typeof feedbacksTable.$inferSelect, i: number) => {
        const msg = f.message.length > 100 ? f.message.slice(0, 100) + "…" : f.message;
        const stars = f.stars ? " · " + "⭐".repeat(f.stars) + `(${f.stars}/5)` : "";
        return `**${i + 1}.** ${typeLabel[f.type] ?? f.type}${stars}\n📝 ${msg}\n📧 ${f.contact || "—"} · 🕒 ${formatDate(f.createdAt)}`;
      });
      const embed = new EmbedBuilder()
        .setColor(0x00e5ff)
        .setTitle(`📩 Góp ý & Báo lỗi (${feedbacks.length})`)
        .setDescription(lines.join("\n\n"))
        .setFooter({ text: "Hiển thị tối đa 15 mục gần nhất" })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });

    // ── /chatchapnhan ─────────────────────────────────────────────────────────
    } else if (cmd === "chatchapnhan") {
      const sessionId  = interaction.options.getInteger("id", true);
      const adminName  = interaction.member && "displayName" in interaction.member
        ? (interaction.member as { displayName: string }).displayName
        : interaction.user.username;
      const adminAvatar = interaction.user.displayAvatarURL();

      const result = await db.execute(
        sql`UPDATE chat_sessions SET status = 'accepted', admin_name = ${adminName}, admin_avatar = ${adminAvatar}, admin_online = true, updated_at = NOW() WHERE id = ${sessionId} AND status = 'pending' RETURNING id, email, display_name`
      );
      const rows = (result as any).rows ?? [];
      if (rows.length === 0) {
        await interaction.editReply(`❌ Không tìm thấy phiên chat #${sessionId} hoặc đã được chấp nhận rồi.`);
        return;
      }
      const session = rows[0];

      // Gửi tin nhắn chào tới app của người dùng (giống HTTP /chat/admin/accept)
      // — nếu thiếu bước này, người dùng sẽ không thấy admin đã chấp nhận trong modal chat.
      await db.insert(chatMessagesTable).values({
        sessionId: Number(sessionId),
        sender: "admin",
        content: `✅ Admin **${adminName}** đã chấp nhận trò chuyện! Tôi sẽ hỗ trợ bạn ngay.`,
        type: "text",
      });

      const embed = new EmbedBuilder()
        .setColor(0x00e676)
        .setTitle(`✅ Đã chấp nhận phiên chat #${sessionId}`)
        .addFields(
          { name: "📧 Email",   value: session.email,                 inline: true },
          { name: "👤 Tên",     value: session.display_name || "—",   inline: true },
          { name: "💡 Lệnh",    value: `/chatra ${sessionId} <tin nhắn>`, inline: false },
        ).setTimestamp();
      await interaction.editReply({ embeds: [embed] });

    // ── /chatra ───────────────────────────────────────────────────────────────
    } else if (cmd === "chatra") {
      const sessionId = interaction.options.getInteger("id", true);
      const text      = interaction.options.getString("tinhnhan", true);
      const result = await db.execute(
        sql`SELECT id, status, device_id FROM chat_sessions WHERE id = ${sessionId}`
      );
      const session = ((result as any).rows ?? [])[0];
      if (!session) {
        await interaction.editReply(`❌ Không tìm thấy phiên chat #${sessionId}.`);
        return;
      }
      if (session.status !== "accepted") {
        await interaction.editReply(`❌ Phiên chat #${sessionId} chưa được chấp nhận. Dùng /chatchapnhan trước.`);
        return;
      }
      await db.execute(
        sql`INSERT INTO chat_messages (session_id, sender, content, type, created_at) VALUES (${sessionId}, 'admin', ${text}, 'text', NOW())`
      );
      await db.execute(
        sql`UPDATE chat_sessions SET updated_at = NOW() WHERE id = ${sessionId}`
      );
      await interaction.editReply(`✅ Đã gửi tin nhắn đến phiên chat #${sessionId}.`);

    // ── /chatguianh ───────────────────────────────────────────────────────────
    } else if (cmd === "chatguianh") {
      const sessionId = interaction.options.getInteger("id", true);
      const url       = interaction.options.getString("url", true);
      const result = await db.execute(
        sql`SELECT id, status FROM chat_sessions WHERE id = ${sessionId}`
      );
      const session = ((result as any).rows ?? [])[0];
      if (!session) {
        await interaction.editReply(`❌ Không tìm thấy phiên chat #${sessionId}.`);
        return;
      }
      if (session.status !== "accepted") {
        await interaction.editReply(`❌ Phiên chat #${sessionId} chưa được chấp nhận.`);
        return;
      }
      await db.execute(
        sql`INSERT INTO chat_messages (session_id, sender, content, type, image_data, created_at) VALUES (${sessionId}, 'admin', '', 'image', ${url}, NOW())`
      );
      await db.execute(
        sql`UPDATE chat_sessions SET updated_at = NOW() WHERE id = ${sessionId}`
      );
      await interaction.editReply(`✅ Đã gửi ảnh đến phiên chat #${sessionId}.`);

    // ── /chatthoat ─────────────────────────────────────────────────────────────
    } else if (cmd === "chatthoat") {
      const sessionId = interaction.options.getInteger("id", true);

      // Thông báo cho người dùng trong modal chat (giống HTTP /chat/admin/close) —
      // thiếu bước này thì app không hiển thị gì khi admin đóng phiên chat.
      await db.insert(chatMessagesTable).values({
        sessionId: Number(sessionId),
        sender: "bot",
        content: "❌ Admin đã kết thúc phiên trò chuyện. Cảm ơn bạn đã liên hệ! Nếu cần hỗ trợ thêm, hãy bắt đầu cuộc trò chuyện mới.",
        type: "text",
      });

      await db.execute(
        sql`UPDATE chat_sessions SET status = 'closed', admin_online = false, updated_at = NOW() WHERE id = ${sessionId}`
      );

      const embed = new EmbedBuilder()
        .setColor(0xff5722)
        .setTitle("🚪 Đã đóng phiên chat #" + sessionId)
        .setDescription("Người dùng đã được thông báo phiên chat kết thúc.")
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });

    // ── /chatdanhsach ─────────────────────────────────────────────────────────
    } else if (cmd === "chatdanhsach") {
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

    // ── /thongbaodaybp ────────────────────────────────────────────────────────
    } else if (cmd === "thongbaodaybp") {
      const title  = interaction.options.getString("tieude", true);
      const body   = interaction.options.getString("noidung", true);

      if (!isFcmConfigured()) {
        await interaction.editReply("❌ FCM chưa được cấu hình. Thêm biến môi trường `FIREBASE_SERVICE_ACCOUNT_JSON`.");
        return;
      }

      // Lấy tất cả FCM token
      const tokens = await db.select().from(fcmTokensTable);
      if (tokens.length === 0) {
        await interaction.editReply("📭 Chưa có thiết bị nào đăng ký nhận push notification.");
        return;
      }

      let successCount = 0;
      let failCount = 0;
      const batchSize = 500;

      for (let i = 0; i < tokens.length; i += batchSize) {
        const batch = tokens.slice(i, i + batchSize).map(t => t.fcmToken);
        try {
          const result = await sendFcmPush(batch, title, body);
          successCount += result.sent   ?? 0;
          failCount    += result.failed ?? 0;
        } catch (err) {
          logger.error({ err }, "FCM batch push error");
          failCount += batch.length;
        }
      }

      const embed = new EmbedBuilder()
        .setColor(successCount > 0 ? 0x00e676 : 0xff5252)
        .setTitle("📲 Đã gửi push notification")
        .addFields(
          { name: "📌 Tiêu đề",  value: title,            inline: false },
          { name: "📝 Nội dung", value: body,             inline: false },
          { name: "✅ Thành công", value: `${successCount}`, inline: true },
          { name: "❌ Thất bại",  value: `${failCount}`,    inline: true },
          { name: "📱 Tổng",      value: `${tokens.length}`, inline: true },
        ).setTimestamp();
      await interaction.editReply({ embeds: [embed] });

    // ════════════════════════════════════════════════════════════════════════
    // FORCE UPDATE COMMANDS
    // ════════════════════════════════════════════════════════════════════════

    // ── /update ───────────────────────────────────────────────────────────────
    } else if (cmd === "update") {
      const trangThai  = interaction.options.getString("trang_thai", true); // "on" | "off"
      const phienBan   = interaction.options.getInteger("phien_ban");       // optional

      const enabled = trangThai === "on";

      // Đọc config hiện tại để giữ nguyên nếu không truyền phiên bản
      const currentConfig = await getAppConfig();
      const currentMinVer = parseInt(currentConfig["min_version_code"] ?? "0", 10);
      const newMinVer     = phienBan != null ? phienBan : currentMinVer;

      await Promise.all([
        setAppConfig("force_update_enabled", enabled ? "true" : "false"),
        setAppConfig("min_version_code", String(newMinVer)),
      ]);

      const downloadUrl = currentConfig["download_url"] ?? "";
      const statusIcon  = enabled ? "🟢" : "🔴";
      const statusText  = enabled ? "BẬT — người dùng bắt buộc cập nhật" : "TẮT — cho vào app bình thường";

      const embed = new EmbedBuilder()
        .setColor(enabled ? 0xff5722 : 0x00e676)
        .setTitle(`${statusIcon} Force Update: ${enabled ? "ON" : "OFF"}`)
        .addFields(
          { name: "📌 Trạng thái",          value: statusText,                        inline: false },
          { name: "🔢 VersionCode tối thiểu", value: `${newMinVer}`,                   inline: true  },
          { name: "🔗 Link tải APK",          value: downloadUrl || "*(chưa đặt)*",    inline: false },
        )
        .setFooter({ text: "Dùng /setdownloadurl để đặt link tải APK · /statusupdate để xem trạng thái" })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });

    // ── /setdownloadurl ───────────────────────────────────────────────────────
    } else if (cmd === "setdownloadurl") {
      const url = interaction.options.getString("url", true).trim();

      // Validate URL cơ bản
      try {
        new URL(url);
      } catch {
        await interaction.editReply("❌ URL không hợp lệ. Vui lòng nhập URL đúng định dạng (bắt đầu bằng https:// hoặc http://).");
        return;
      }

      await setAppConfig("download_url", url);

      const embed = new EmbedBuilder()
        .setColor(0x2196f3)
        .setTitle("🔗 Đã cập nhật link tải APK")
        .addFields(
          { name: "🔗 URL",         value: url,  inline: false },
          { name: "💡 Hướng dẫn",   value: "Người dùng nhấn **[Cập nhật]** trong app sẽ được chuyển đến link này.", inline: false },
        )
        .setFooter({ text: "Dùng /update on để bật force update cho người dùng" })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });

    // ── /statusupdate ─────────────────────────────────────────────────────────
    } else if (cmd === "statusupdate") {
      const config = await getAppConfig();

      const forceEnabled  = config["force_update_enabled"] === "true";
      const minVersionCode = config["min_version_code"] ?? "0";
      const downloadUrl   = config["download_url"] ?? "";

      const statusIcon = forceEnabled ? "🟢 BẬT" : "🔴 TẮT";

      const embed = new EmbedBuilder()
        .setColor(forceEnabled ? 0xff5722 : 0x4caf50)
        .setTitle("📊 Trạng thái Force Update")
        .addFields(
          { name: "🔄 Force Update",           value: statusIcon,                      inline: true  },
          { name: "🔢 VersionCode tối thiểu",  value: minVersionCode,                  inline: true  },
          { name: "🔗 Link tải APK",            value: downloadUrl || "*(chưa đặt)*",   inline: false },
        )
        .addFields({
          name: "📋 Hướng dẫn sử dụng",
          value:
            "`/update on [phien_ban]` — Bật force update\n" +
            "`/update off` — Tắt force update\n" +
            "`/setdownloadurl <url>` — Đặt link tải APK\n" +
            "`/statusupdate` — Xem trạng thái này",
          inline: false,
        })
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

const LOG_CHANNEL_ID  = process.env.DISCORD_LOG_CHANNEL_ID  ?? "";
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
  | "KEY_REINSTALL"      // Thiết bị cùng phần cứng cài lại app, slot được kích hoạt lại
  | "GOOGLE_LOGIN"       // Người dùng đăng nhập Google thành công từ app
  | "FEEDBACK";          // Người dùng gửi báo lỗi / góp ý / liên hệ từ app

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
    case "KEY_REINSTALL":    return { color: 0x00ACC1, icon: "🔄", title: "Thiết Bị Cài Lại (Cùng Phần Cứng)" };
    case "FEEDBACK":         return { color: 0xFFAB00, icon: "📩", title: "Phản Hồi Từ Người Dùng" };
    default:                 return { color: 0x00E5FF, icon: "📩", title: "Sự Kiện" };
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
