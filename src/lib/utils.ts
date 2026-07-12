/** Shared utility: sanitize unknown input to a safe string */
export function sanitize(s: unknown, maxLen = 2000): string {
  if (typeof s !== "string") return "";
  return s.trim().slice(0, maxLen);
}
