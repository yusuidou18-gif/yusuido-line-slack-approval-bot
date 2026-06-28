const EMERGENCY_KEYWORDS = [
  "水漏れ",
  "漏水",
  "雨漏り",
  "漏電",
  "停電",
  "火花",
  "焦げ",
  "使えない",
  "使用できない",
  "止まらない",
  "詰まり",
  "つまった",
  "あふれ",
  "溢れ",
  "破損",
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
  "聞いてない",
  "トラブル",
  "やり直し",
  "直っていない"
];

const MONEY_RISK_KEYWORDS = [
  "値引き",
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

const SITE_VISIT_STAFF_NAMES = ["下村", "下村奈生", "菅野", "菅野香織"];
const DEFAULT_PHONE = "047-401-0700";
const DEFAULT_BUSINESS_HOURS = "営業時間 10:00-19:00／定休日 日曜・月曜";

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

  const hasComplaintHistory = /あり|有|クレーム|トラブル|苦情/.test(complaintHistory);
  const isOb =
    Boolean(obHit) ||
    /OB|リピーター|既存|再依頼|以前/.test(driveCustomerType) ||
    /OB|リピーター|既存|再依頼|以前/.test(caseStatus);

  const riskHit = complaintHit || moneyHit || legalHit || hasComplaintHistory;
  const needsSiteVisit = Boolean(siteVisitHit || /写真|寸法|サイズ|場所|症状/.test(normalized));
  const urgency = emergencyHit || complaintHit || legalHit ? "高" : needsSiteVisit || scheduleHit || moneyHit ? "中" : "低";
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
  if (legalHit) reasons.push(`「${legalHit}」を含むため法的・口コミリスクの可能性あり`);
  if (siteVisitHit) reasons.push(`「${siteVisitHit}」を含むため現地確認へ自然に誘導`);
  if (scheduleHit) reasons.push(`「${scheduleHit}」を含むため日程確認が必要`);
  if (hasComplaintHistory) reasons.push("Google Drive上にクレーム・トラブル履歴の可能性あり");
  if (isOb) reasons.push("OB顧客の可能性があるため優先対応");
  if (caseInfo?.matchedFiles?.length) reasons.push("Google Driveに候補案件情報あり");
  if (!caseInfo?.matchedFiles?.length) reasons.push("案件情報は未特定。ただし顧客返信では社内確認だけで終わらせず、次の行動を案内");
  if (!reasons.length) reasons.push("一般問い合わせとして一次返信案を作成");

  return {
    urgency,
    presidentRequired,
    isOb,
    needsSiteVisit,
    templateKey,
    reason: reasons.join("。 ")
  };
}

export function buildReplyDraft({ text, analysis, config, caseInfo, calendarInfo }) {
  const templateKey = analysis?.templateKey || "general";
  const context = buildReplyContext({ text, analysis, config, caseInfo, calendarInfo });
  const templates = {
    emergency: buildEmergencyReply,
    complaint: buildComplaintReply,
    money: buildMoneyReply,
    siteVisit: buildSiteVisitReply,
    schedule: buildScheduleReply,
    ob: buildObReply,
    legalReputation: buildLegalReply,
    general: buildGeneralReply
  };

  const builder = templates[templateKey] || templates.general;
  return cleanupDraft(builder(context).join("\n"));
}

function buildReplyContext({ text, analysis, config, caseInfo, calendarInfo }) {
  const caseData = caseInfo?.case || {};
  const slots = summarizeSiteVisitSlots(calendarInfo);
  const phone = config?.companyPhone || DEFAULT_PHONE;
  const hours = config?.businessHoursText || DEFAULT_BUSINESS_HOURS;
  const hasCase = Boolean(caseInfo?.matchedFiles?.length);
  const customerName = caseData.customerName || "";
  const staffName = caseData.staffName || "";
  const estimateStatus = caseData.estimateStatus || "";
  const constructionSchedule = caseData.constructionSchedule || "";

  return {
    text,
    analysis,
    caseData,
    hasCase,
    customerName,
    staffName,
    estimateStatus,
    constructionSchedule,
    slots,
    phone,
    hours,
    slotLine: slots.length ? `現地確認は、直近ですと${slots.join("、")}あたりで調整できる可能性がございます。` : "",
    staffLine: staffName ? `${staffName}が内容を確認いたします。` : "担当者が内容を確認いたします。",
    caseLine: hasCase ? "過去のやり取りも確認したうえでご案内いたします。" : "必要な情報を確認しながら進めさせていただきます。",
    hoursLine: `受付時間の目安は${hours}です。`
  };
}

function buildEmergencyReply(ctx) {
  return [
    "お問い合わせありがとうございます。",
    "",
    "ご不安な状況かと存じます。",
    "水漏れ・漏電・使用できない等の緊急性がある場合は、状況確認を急ぎます。",
    `お急ぎの場合は、お電話（${ctx.phone}）でもご連絡ください。`,
    "",
    "社内で確認し、対応可否やお伺い可能時間をあらためてご連絡いたします。",
    "差し支えなければ、現在の状況が分かるお写真もお送りください。"
  ];
}

function buildComplaintReply(ctx) {
  return [
    "ご連絡ありがとうございます。",
    "",
    "このたびはご不安・ご不快なお気持ちにさせてしまい、申し訳ございません。",
    ctx.caseLine,
    "事実関係を確認したうえで、担当者よりあらためてご連絡いたします。",
    "",
    "確認前に断定したご案内は控えさせていただきますが、誠実に対応いたします。"
  ];
}

function buildMoneyReply(ctx) {
  return [
    "お問い合わせありがとうございます。",
    "",
    "費用に関するご相談として承りました。",
    "金額・値引き・返金に関わる内容は社内確認が必要なため、現時点では確定したご案内は控えさせていただきます。",
    ctx.caseLine,
    "",
    "確認のうえ、あらためてご連絡いたします。"
  ];
}

function buildSiteVisitReply(ctx) {
  const lines = [
    "お問い合わせありがとうございます。",
    "",
    "状況を拝見したうえで、できるだけ分かりやすくご案内いたします。",
    ctx.caseLine
  ];

  if (ctx.slotLine) {
    lines.push(ctx.slotLine);
  } else {
    lines.push("現地確認が必要な場合は、下村または菅野の予定を確認して日程をご相談いたします。");
  }

  lines.push(
    "",
    "差し支えなければ、気になる箇所のお写真と、ご希望の時間帯をお送りください。"
  );
  return lines;
}

function buildScheduleReply(ctx) {
  const lines = [
    "ご連絡ありがとうございます。",
    "",
    "日程について確認いたします。",
    ctx.caseLine
  ];

  if (ctx.slotLine) {
    lines.push(ctx.slotLine);
  } else {
    lines.push("営業時間は10:00-19:00、定休日は日曜・月曜です。候補日を確認してご案内いたします。");
  }

  lines.push("", "ご希望の曜日や時間帯がございましたら、お知らせください。");
  return lines;
}

function buildObReply(ctx) {
  return [
    "いつもありがとうございます。",
    "",
    "以前のご対応内容も確認したうえで、優先して確認いたします。",
    ctx.staffLine,
    ctx.slotLine || "必要に応じて、現地確認の日程もご相談させてください。",
    "",
    "現在の状況が分かるお写真がございましたら、お送りいただけますと確認がスムーズです。"
  ];
}

function buildLegalReply(ctx) {
  return [
    "ご連絡ありがとうございます。",
    "",
    "内容を真摯に受け止め、社内で確認いたします。",
    "事実関係を確認したうえで、担当者よりあらためてご連絡いたします。",
    "",
    "確認前に断定したご案内は控えさせていただきますが、できるだけ丁寧に対応いたします。"
  ];
}

function buildGeneralReply(ctx) {
  return [
    "お問い合わせありがとうございます。",
    "",
    "内容を確認いたしました。",
    ctx.caseLine,
    ctx.staffLine,
    "",
    "確認のうえ、次のご案内をお送りいたします。"
  ];
}

function summarizeSiteVisitSlots(calendarInfo) {
  if (!Array.isArray(calendarInfo)) return [];
  return calendarInfo
    .filter((calendar) => isSiteVisitStaff(calendar.staffName || calendar.name))
    .flatMap((calendar) =>
      (calendar.availableSlots || []).slice(0, 2).map((slot) => {
        const start = new Date(slot.start);
        const label = new Intl.DateTimeFormat("ja-JP", {
          timeZone: "Asia/Tokyo",
          month: "numeric",
          day: "numeric",
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit"
        }).format(start);
        return `${calendar.staffName || calendar.name} ${label}`;
      })
    )
    .slice(0, 4);
}

function isSiteVisitStaff(value) {
  const text = normalizeText(value);
  return SITE_VISIT_STAFF_NAMES.some((name) => text.includes(name));
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
