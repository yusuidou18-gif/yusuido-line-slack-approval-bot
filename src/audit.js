import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.resolve("data");
const AUDIT_PATH = path.join(DATA_DIR, "audit-log.ndjson");

export function hashId(value) {
  if (!value) return "";
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

export function maskId(value) {
  if (!value) return "";
  const text = String(value);
  if (text.length <= 8) return "****";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

export async function audit(event, fields = {}) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const record = {
    at: new Date().toISOString(),
    event,
    ...sanitize(fields)
  };
  await fs.appendFile(AUDIT_PATH, `${JSON.stringify(record)}\n`);
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;

  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/lineUserId|replyToken|channelAccessToken|botToken|privateKey|secret/i.test(key)) {
      output[key] = entry ? `[masked:${hashId(entry)}]` : "";
      continue;
    }
    output[key] = sanitize(entry);
  }
  return output;
}
