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
  /lineUserId/i,
  /下村/,
  /菅野/,
  /吉原/,
  /時本/,
  /廣田/
];

const GENERIC_HOLD_PATTERNS = [
  /担当者が内容を確認いたします。?\s*確認のうえ、次のご案内をお送りいたします。?/,
  /確認いたします。?\s*確認のうえ、あらためてご連絡いたします。?/,
  /内容を確認いたしました。?\s*必要な情報を確認しながら進めさせていただきます。?\s*確認のうえ/
];

const NEXT_ACTION_PATTERNS = [
  /お写真/,
  /ご希望/,
  /候補/,
  /お電話/,
  /対応方針/,
  /ご案内/,
  /お知らせ/,
  /お伺い/,
  /ご連絡/
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
  if (!NEXT_ACTION_PATTERNS.some((pattern) => pattern.test(text))) {
    errors.push("次のアクションが不足しています");
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

export function snapshotHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value || {})).digest("hex").slice(0, 24);
}
