import crypto from "node:crypto";

export function verifyLineSignature(channelSecret, rawBody, signature) {
  if (!channelSecret || !signature) return false;
  const digest = crypto
    .createHmac("sha256", channelSecret)
    .update(rawBody)
    .digest("base64");
  return timingSafeEqual(digest, signature);
}

export function verifySlackSignature(signingSecret, rawBody, timestamp, signature) {
  if (!signingSecret || !timestamp || !signature) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 60 * 5) return false;

  const base = `v0:${timestamp}:${rawBody.toString("utf8")}`;
  const digest =
    "v0=" +
    crypto.createHmac("sha256", signingSecret).update(base).digest("hex");

  return timingSafeEqual(digest, signature);
}

export function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function createId(prefix = "req") {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
}
