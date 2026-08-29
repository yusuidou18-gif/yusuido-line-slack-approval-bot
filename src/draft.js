import crypto from "node:crypto";

const INTERNAL_PATTERNS = [
  /Google Drive/i,
  /Google Calendar/i,
  /Slack/i,
  /承認者/,
  /判断理由/,
  /社長確認[:：]/,
  /案件ID[:：]/,
  /LINE ID/i,
  /lineUserId/i
];

const GENERIC_HOLD_PATTERNS = [
  /担当者が内容を確認いたします。?\s*確認のうえ、次のご案内をお送りいたします。?/,
  /確認いたします。?\s*確認のうえ、あらためてご連絡いたします。?/
];

export function createDraftMetadata({ id, version = 1, replyDraft, customerMessage, caseId, lineMessageId, now = new Date() }) {
  return {
    id,
    version,
    status: "pending",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    snapshotHash: snapshotHash({ replyDraft, customerMessage, caseId, lineMessageId })
  };
}

export function validateReplyDraft(replyDraft, { allowGeneric = false } = {}) {
  const text = String(replyDraft || "").trim();
  const errors = [];

  if (!text) errors.push("返信案が空です");
  if (text.length > 900) errors.push("LINE返信として長すぎます");
  if (INTERNAL_PATTERNS.some((pattern) => pattern.test(text))) {
    errors.push("顧客向け本文に社内情報が含まれています");
  }
  if (!allowGeneric && GENERIC_HOLD_PATTERNS.some((pattern) => pattern.test(text))) {
    errors.push("返信案が一般的すぎます");
  }
  if (!/(ありがとうございます|ご連絡|お問い合わせ)/.test(text)) {
    errors.push("冒頭の謝意または受領表現が不足しています");
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

export function snapshotHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value || {})).digest("hex").slice(0, 24);
}
