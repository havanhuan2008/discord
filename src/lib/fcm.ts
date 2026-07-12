/**
 * fcm.ts — Helper gửi Firebase Cloud Messaging (FCM HTTP v1 API)
 *
 * Cấu hình môi trường cần thiết:
 *   FIREBASE_SERVICE_ACCOUNT_JSON  — toàn bộ nội dung file service-account.json
 *                                    (từ Firebase Console → Project settings → Service accounts)
 *   FIREBASE_PROJECT_ID            — Project ID (có trong service account JSON, hoặc đặt riêng)
 *
 * FCM v1 API gửi từng token một (không hỗ trợ registration_ids như Legacy).
 * Hàm sendFcmPush() xử lý tự động theo batch song song để tối ưu tốc độ.
 */

import { logger } from "./logger.js";

// ─── Đọc cấu hình từ env ─────────────────────────────────────────────────────

function getServiceAccount(): Record<string, string> | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?? "";
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    logger.error("FIREBASE_SERVICE_ACCOUNT_JSON không phải JSON hợp lệ");
    return null;
  }
}

function getProjectId(): string {
  const explicit = process.env.FIREBASE_PROJECT_ID ?? "";
  if (explicit) return explicit;
  const sa = getServiceAccount();
  return sa?.project_id ?? "";
}

// ─── Lấy OAuth2 access token từ service account ──────────────────────────────

async function getAccessToken(): Promise<string> {
  const sa = getServiceAccount();
  if (!sa) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON chưa được cấu hình");

  const clientEmail: string = sa.client_email ?? "";
  const privateKey:  string = (sa.private_key ?? "").replace(/\\n/g, "\n");

  if (!clientEmail || !privateKey) {
    throw new Error("service account JSON thiếu client_email hoặc private_key");
  }

  const now   = Math.floor(Date.now() / 1000);
  const claim = {
    iss:   clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud:   "https://oauth2.googleapis.com/token",
    iat:   now,
    exp:   now + 3600,
  };

  // Tạo JWT bằng Web Crypto API (không cần thư viện ngoài)
  const header  = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const payload = btoa(JSON.stringify(claim)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const sigInput = `${header}.${payload}`;

  // Import khóa RSA từ PEM
  const pemBody = privateKey
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const keyBytes = Buffer.from(pemBody, "base64");

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    Buffer.from(sigInput),
  );

  const sigB64 = Buffer.from(sig).toString("base64")
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const jwt = `${sigInput}.${sigB64}`;

  // Đổi JWT lấy access token
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion:  jwt,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`OAuth token request failed: ${txt}`);
  }

  const json = await resp.json() as { access_token?: string };
  if (!json.access_token) throw new Error("OAuth response thiếu access_token");
  return json.access_token;
}

// ─── Gửi một message FCM v1 ───────────────────────────────────────────────────

async function sendOne(
  token: string,
  title: string,
  body:  string,
  accessToken: string,
  projectId:   string,
): Promise<"ok" | "invalid_token" | "error"> {
  try {
    const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          android: {
            priority: "high",
            notification: { sound: "default" },
          },
        },
      }),
    });

    if (res.ok) return "ok";

    const errJson = await res.json().catch(() => ({})) as { error?: { code?: number; status?: string } };
    const status  = errJson?.error?.status ?? "";
    // Token không còn hợp lệ → nên xóa khỏi DB
    if (status === "INVALID_ARGUMENT" || status === "NOT_FOUND" || status === "UNREGISTERED") {
      return "invalid_token";
    }
    return "error";
  } catch {
    return "error";
  }
}

// ─── Public: Gửi đến nhiều token ─────────────────────────────────────────────

export interface FcmSendResult {
  total:         number;
  sent:          number;
  failed:        number;
  invalidTokens: string[];
  error?:        string;
}

export async function sendFcmPush(
  tokens: string[],
  title:  string,
  body:   string,
): Promise<FcmSendResult> {
  if (tokens.length === 0) {
    return { total: 0, sent: 0, failed: 0, invalidTokens: [] };
  }

  const projectId = getProjectId();
  if (!projectId) {
    return { total: tokens.length, sent: 0, failed: tokens.length, invalidTokens: [],
      error: "FIREBASE_PROJECT_ID chưa được cấu hình (hoặc thiếu project_id trong service account JSON)" };
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { total: tokens.length, sent: 0, failed: tokens.length, invalidTokens: [], error: msg };
  }

  // Gửi song song, tối đa 50 request đồng thời
  const CONCURRENCY = 50;
  let sent = 0, failed = 0;
  const invalidTokens: string[] = [];

  for (let i = 0; i < tokens.length; i += CONCURRENCY) {
    const batch   = tokens.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(t => sendOne(t, title, body, accessToken, projectId)),
    );
    results.forEach((r, idx) => {
      if (r === "ok")            sent++;
      else if (r === "invalid_token") { failed++; invalidTokens.push(batch[idx]); }
      else                       failed++;
    });
  }

  return { total: tokens.length, sent, failed, invalidTokens };
}

export function isFcmConfigured(): boolean {
  return !!(getServiceAccount() && getProjectId());
}
