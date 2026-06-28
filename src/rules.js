const EMERGENCY_KEYWORDS = [
  "水漏れ",
  "漏水",
  "雨漏り",
  "漏電",
  "停電",
  "火花",
  "焦げ臭い",
  "使えない",
  "使用できない",
  "止まらない",
  "詰まり",
  "つまった",
  "あふれ",
  "溢れ",
  "破裂",
  "故障",
  "至急",
  "緊急",
  "今日中",
  "今すぐ",
  "すぐ来て",
  "危ない",
  "危険"
];

const COMPLAINT_KEYWORDS = [
  "クレーム",
  "苦情",
  "不満",
  "納得できない",
  "怒",
  "ひどい",
  "困っている",
  "説明して",
  "連絡がない",
  "聞いていない",
  "トラブル",
  "やり直し",
  "直っていない"
];

const MONEY_RISK_KEYWORDS = [
  "値引",
  "割引",
  "安く",
  "返金",
  "減額",
  "無料",
  "キャンセル料",
  "支払い",
  "請求",
  "高い",
  "追加費用"
];

const LEGAL_REPUTATION_KEYWORDS = [
  "弁護士",
  "訴",
  "法的",
  "消費者センター",
  "口コミ",
  "レビュー",
  "SNS",
  "投稿",
  "拡散"
];

const SITE_VISIT_KEYWORDS = [
  "見積",
  "現調",
  "現地調査",
  "下見",
  "相談",
  "依頼",
  "お願い",
  "修理",
  "点検",
  "交換",
  "リフォーム"
];

const SCHEDULE_KEYWORDS = [
  "日程",
  "予定",
  "いつ",
  "工事日",
  "何時",
  "時間",
  "変更",
  "延期",
  "キャンセル"
];

const OB_KEYWORDS = [
  "以前",
  "前に",
  "また",
  "再度",
  "リピート",
  "OB",
  "工事してもらった",
  "お世話になりました",
  "湧水堂さんで"
];

export function analyzeMessage(text, caseInfo) {
  const normalized = normalizeText(text);
  const driveCustomerType = normalizeText(caseInfo?.case?.customerType);
  const caseStatus = normalizeText(caseInfo?.case?.caseStatus);
  const complaintHistory = normalizeText(caseInfo?.case?.complaintHistory);

  const emergencyHit = findHit(normalized, EMERGENCY_KEYWORDS);
  const complaintHit = findHit(normalized, COMPLAINT_KEYWORDS);
  const moneyHit = findHit(normalized, MONEY_RISK_KEYWORDS);
  const legalHit = findHit(normalized, LEGAL_REPUTATION_KEYWORDS);
  const siteVisitHit = findHit(normalized, SITE_VISIT_KEYWORDS);
  const scheduleHit = findHit(normalized, SCHEDULE_KEYWORDS);
  const obHit = findHit(normalized, OB_KEYWORDS);

  const hasComplaintHistory = /あり|有|過去|クレーム|トラブル/.test(complaintHistory);
  const isOb =
    Boolean(obHit) ||
    /OB|リピート|既存|再依頼|以前/.test(driveCustomerType) ||
    /OB|リピート|既存|再依頼|以前/.test(caseStatus);

  const riskHit = complaintHit || moneyHit || legalHit || hasComplaintHistory;
  const urgency = emergencyHit || complaintHit || legalHit ? "高" : siteVisitHit || scheduleHit || moneyHit ? "中" : "低";
  const presidentRequired = Boolean(emergencyHit || riskHit);
  const templateKey = chooseTemplateKey({
    emergencyHit,
    complaintHit,
    moneyHit,
    legalHit,
    siteVisitHit,
    scheduleHit,
    isOb
  });

  const reasons = [];
  if (emergencyHit) reasons.push(`「${emergencyHit}」を含むため緊急度を高と判定`);
  if (complaintHit) reasons.push(`「${complaintHit}」を含むためクレーム・不満の可能性あり`);
  if (moneyHit) reasons.push(`「${moneyHit}」を含むため金額・返金・値引きに関する社長確認が必要`);
  if (legalHit) reasons.push(`「${legalHit}」を含むため法務・口コミリスクの可能性あり`);
  if (siteVisitHit) reasons.push(`「${siteVisitHit}」を含むため現調または担当者確認へ誘導`);
  if (scheduleHit) reasons.push(`「${scheduleHit}」を含むため日程確認が必要`);
  if (hasComplaintHistory) reasons.push("Google Drive上にクレーム・トラブル履歴の可能性あり");
  if (isOb) reasons.push("OB顧客の可能性があるため優先対応");
  if (caseInfo?.matchedFiles?.length) reasons.push("Google Driveに候補案件情報あり");
  if (!caseInfo?.matchedFiles?.length) reasons.push("案件情報が未特定のため担当者確認が必要");
  if (!reasons.length) reasons.push("一般問い合わせとして一次返信案を作成");

  return {
    urgency,
    presidentRequired,
    isOb,
    templateKey,
    reason: reasons.join("。 ")
  };
}

export function buildReplyDraft({ text, analysis, config }) {
  const templateKey = analysis?.templateKey || "general";
  const phoneLine = buildPhoneLine(config);
  const businessHoursLine = config?.businessHoursText
    ? `\n受付時間の目安：${config.businessHoursText}`
    : "";

  const templates = {
    emergency: [
      "お問い合わせありがとうございます。",
      "",
      "ご不安な状況かと存じます。",
      "水漏れ・漏電・使用できない等の緊急性がある場合は、状況確認を急ぎます。",
      phoneLine,
      "",
      "担当者と社内で確認し、対応可否やお伺い可能時間をあらためてご連絡いたします。",
      "恐れ入りますが、現在の状況が分かるお写真もお送りいただけますと助かります。"
    ],
    complaint: [
      "ご連絡ありがとうございます。",
      "",
      "このたびはご不安・ご不快なお気持ちにさせてしまい、申し訳ございません。",
      "内容を社内で確認し、担当者よりあらためてご連絡いたします。",
      "",
      "確認のうえでご案内いたしますので、少々お時間をいただけますと幸いです。"
    ],
    money: [
      "お問い合わせありがとうございます。",
      "",
      "金額に関するご相談として承りました。",
      "費用・値引き・返金に関わる内容は社内確認が必要なため、現時点では確定したご案内は控えさせていただきます。",
      "",
      "担当者が内容を確認し、あらためてご連絡いたします。"
    ],
    siteVisit: [
      "お問い合わせありがとうございます。",
      "",
      "状況を拝見しないと正確なご案内が難しい可能性がございます。",
      "まずは担当者が内容を確認し、必要に応じて現地確認の日程をご相談させていただきます。",
      "",
      "差し支えなければ、気になる箇所のお写真やご希望の時間帯をお送りください。"
    ],
    schedule: [
      "ご連絡ありがとうございます。",
      "",
      "日程について確認いたします。",
      "担当者の予定と工事状況を確認したうえで、あらためてご連絡いたします。",
      "",
      "ご希望の候補日や時間帯がありましたら、いくつかお送りいただけますと調整しやすくなります。"
    ],
    ob: [
      "いつもありがとうございます。",
      "",
      "以前のご対応内容も確認したうえで、優先して確認いたします。",
      "担当者よりあらためてご連絡いたします。",
      "",
      "差し支えなければ、現在の状況が分かるお写真もお送りください。"
    ],
    legalReputation: [
      "ご連絡ありがとうございます。",
      "",
      "内容を真摯に受け止め、社内で確認いたします。",
      "事実関係を確認したうえで、担当者よりあらためてご連絡いたします。",
      "",
      "確認前に断定したご案内は控えさせていただきますが、できるだけ丁寧に対応いたします。"
    ],
    general: [
      "お問い合わせありがとうございます。",
      "",
      "内容を確認いたしました。",
      "詳細を社内で確認し、担当者よりあらためてご連絡いたします。",
      "",
      "少々お時間をいただけますと幸いです。"
    ]
  };

  const selected = templates[templateKey] || templates.general;
  return cleanupDraft(selected.join("\n") + businessHoursLine);
}

function chooseTemplateKey({
  emergencyHit,
  complaintHit,
  moneyHit,
  legalHit,
  siteVisitHit,
  scheduleHit,
  isOb
}) {
  if (legalHit) return "legalReputation";
  if (complaintHit) return "complaint";
  if (emergencyHit) return "emergency";
  if (moneyHit) return "money";
  if (siteVisitHit) return "siteVisit";
  if (scheduleHit) return "schedule";
  if (isOb) return "ob";
  return "general";
}

function buildPhoneLine(config) {
  if (config?.companyPhone) {
    return `お急ぎの場合は、お電話（${config.companyPhone}）でもご連絡ください。`;
  }
  return "お急ぎの場合は、お電話でもご連絡ください。";
}

function cleanupDraft(text) {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findHit(text, keywords) {
  return keywords.find((keyword) => text.includes(keyword)) || "";
}

function normalizeText(value) {
  return String(value || "").normalize("NFKC");
}
