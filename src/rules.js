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
  "直っていない",
  "直っていません",
  "どうなってる",
  "どうなっている"
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

const TOPIC_DEFINITIONS = [
  { key: "toilet", label: "トイレ", patterns: ["トイレ", "便器", "ウォシュレット", "温水洗浄便座"] },
  { key: "kitchen", label: "キッチン・台所", patterns: ["キッチン", "台所", "シンク", "水栓", "蛇口"] },
  { key: "bath", label: "浴室・お風呂", patterns: ["浴室", "お風呂", "風呂", "ユニットバス", "シャワー"] },
  { key: "washstand", label: "洗面まわり", patterns: ["洗面", "洗面台", "洗面所"] },
  { key: "waterHeater", label: "給湯器", patterns: ["給湯器", "エコキュート", "お湯"] },
  { key: "leak", label: "水漏れ", patterns: ["水漏れ", "漏水", "漏れ", "止まらない"] },
  { key: "clog", label: "詰まり", patterns: ["詰まり", "つまった", "詰まった", "流れない"] },
  { key: "estimate", label: "お見積り", patterns: ["見積", "見積り", "見積もり", "概算"] },
  { key: "schedule", label: "日程", patterns: ["日程", "予定", "時間", "何時", "曜日", "午前", "午後"] },
  { key: "construction", label: "工事", patterns: ["工事", "施工", "作業"] },
  { key: "repair", label: "修理", patterns: ["修理", "直し", "直して", "点検"] },
  { key: "replacement", label: "交換", patterns: ["交換", "取替", "取り替え"] },
  { key: "reform", label: "リフォーム", patterns: ["リフォーム", "改修"] }
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
  const hasScheduleExpression = hasDateOrTimeExpression(normalized);
  const obHit = findHit(normalized, OB_KEYWORDS);

  const hasComplaintHistory = /あり|有|クレーム|トラブル|苦情/.test(complaintHistory);
  const isOb =
    Boolean(obHit) ||
    /OB|リピーター|既存|再依頼|以前/.test(driveCustomerType) ||
    /OB|リピーター|既存|再依頼|以前/.test(caseStatus);

  const riskHit = complaintHit || moneyHit || legalHit || hasComplaintHistory;
  const needsSiteVisit = Boolean(siteVisitHit || /写真|寸法|サイズ|場所|症状/.test(normalized));
  const urgency = emergencyHit || complaintHit || legalHit ? "高" : needsSiteVisit || scheduleHit || hasScheduleExpression || moneyHit ? "中" : "低";
  const presidentRequired = Boolean(emergencyHit || riskHit);
  const templateKey = chooseTemplateKey({
    emergencyHit,
    complaintHit,
    moneyHit,
    legalHit,
    siteVisitHit,
    scheduleHit: scheduleHit || (hasScheduleExpression ? "日時希望" : ""),
    isOb
  });

  const reasons = [];
  if (emergencyHit) reasons.push(`「${emergencyHit}」を含むため緊急度を高と判定`);
  if (complaintHit) reasons.push(`「${complaintHit}」を含むためクレーム・不満の可能性あり`);
  if (moneyHit) reasons.push(`「${moneyHit}」を含むため金額・返金・値引きに関する社長確認が必要`);
  if (legalHit) reasons.push(`「${legalHit}」を含むため法的・口コミリスクの可能性あり`);
  if (siteVisitHit) reasons.push(`「${siteVisitHit}」を含むため現地確認へ自然に誘導`);
  if (scheduleHit) reasons.push(`「${scheduleHit}」を含むため日程確認が必要`);
  if (!scheduleHit && hasScheduleExpression) reasons.push("日時希望の表現を含むため日程確認が必要");
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
  const schedulePreference = summarizeSchedulePreference(calendarInfo);
  const phone = config?.companyPhone || DEFAULT_PHONE;
  const hours = config?.businessHoursText || DEFAULT_BUSINESS_HOURS;
  const hasCase = Boolean(caseInfo?.matchedFiles?.length);
  const customerName = caseData.customerName || "";
  const staffName = caseData.staffName || "";
  const estimateStatus = caseData.estimateStatus || "";
  const constructionSchedule = caseData.constructionSchedule || "";
  const topics = detectInquiryTopics(text);
  const topicLabel = buildTopicLabel(topics);
  const requestLabel = buildRequestLabel(topics, analysis);

  return {
    text,
    analysis,
    caseData,
    hasCase,
    customerName,
    estimateStatus,
    constructionSchedule,
    topics,
    topicLabel,
    requestLabel,
    slots,
    schedulePreference,
    phone,
    hours,
    slotLine: slots.length
      ? buildSlotLine(slots, schedulePreference)
      : "",
    acknowledgementLine: buildAcknowledgementLine({ topics, topicLabel, requestLabel, analysis }),
    detailRequestLine: buildDetailRequestLine({ topics, analysis }),
    caseStatusLine: buildCaseStatusLine({ hasCase, estimateStatus, constructionSchedule }),
    caseLine: hasCase ? "過去のやり取りも確認したうえでご案内いたします。" : "必要な情報を確認しながら進めさせていただきます。",
    noSlotLine: buildNoSlotLine(schedulePreference),
    hoursLine: `受付時間の目安は${hours}です。`
  };
}

function buildSlotLine(slots, preference) {
  const condition = formatSchedulePreference(preference);
  if (slots.length === 1 && condition) {
    return [
      `${condition}とのこと、承知しました。`,
      "現地確認の候補として、下記のお時間をご案内できます。",
      `・${slots[0]}`,
      "こちらのお時間でよろしいでしょうか？"
    ].join("\n");
  }

  const lead = condition
    ? `${condition}の条件に近い現地確認の候補日です。`
    : "現地確認の候補日です。";
  return [
    lead,
    ...slots.map((slot) => `・${slot}`),
    "上記の中でご都合のよいお時間があればお知らせください。"
  ].join("\n");
}

function buildEmergencyReply(ctx) {
  return [
    "お問い合わせありがとうございます。",
    "",
    ctx.acknowledgementLine,
    "ご不安な状況かと存じますので、状況確認を急ぎます。",
    `お急ぎの場合は、お電話（${ctx.phone}）でもご連絡ください。`,
    "",
    "対応可否やお伺いできる時間は確認のうえご案内いたします。",
    ctx.detailRequestLine
  ];
}

function buildComplaintReply(ctx) {
  return [
    "ご連絡ありがとうございます。",
    "",
    "このたびはご不安・ご不快なお気持ちにさせてしまい、申し訳ございません。",
    ctx.acknowledgementLine,
    ctx.caseStatusLine,
    "事実関係を確認したうえで、今後の対応方針をご連絡いたします。",
    "",
    "確認前に断定したご案内は控えさせていただきますが、誠実に対応いたします。"
  ];
}

function buildMoneyReply(ctx) {
  return [
    "お問い合わせありがとうございます。",
    "",
    ctx.acknowledgementLine,
    "費用やお支払いに関わる内容は、詳細を確認したうえでご案内いたします。",
    ctx.caseStatusLine,
    "",
    "金額や値引き可否はこの場で確約できませんが、内容を整理してご連絡いたします。"
  ];
}

function buildSiteVisitReply(ctx) {
  const lines = [
    "お問い合わせありがとうございます。",
    "",
    ctx.acknowledgementLine,
    "状況を拝見したうえで、必要な内容を分かりやすくご案内いたします。",
    ctx.caseStatusLine
  ];

  if (ctx.slotLine) {
    lines.push(ctx.slotLine);
  } else if (ctx.noSlotLine) {
    lines.push(ctx.noSlotLine);
  } else {
    lines.push("現地確認が必要な場合は、空き状況を確認して日程をご相談いたします。");
  }

  lines.push(
    "",
    ctx.detailRequestLine
  );
  return lines;
}

function buildScheduleReply(ctx) {
  const lines = [
    "ご連絡ありがとうございます。",
    "",
    ctx.acknowledgementLine,
    ctx.caseStatusLine
  ];

  if (ctx.slotLine) {
    lines.push(ctx.slotLine);
  } else if (ctx.noSlotLine) {
    lines.push(ctx.noSlotLine);
  } else {
    lines.push("営業時間は10:00-19:00、定休日は日曜・月曜です。");
  }

  if (!ctx.slotLine) {
    lines.push("", "火曜から土曜の中で、ご希望の曜日や1時間ほど空く時間帯をお知らせください。");
  }
  return lines;
}

function buildObReply(ctx) {
  return [
    "いつもありがとうございます。",
    "",
    ctx.acknowledgementLine,
    "以前のご対応内容も確認したうえで、優先して進めます。",
    ctx.slotLine || "必要に応じて、現地確認の日程もご相談させてください。",
    "",
    ctx.detailRequestLine
  ];
}

function buildLegalReply(ctx) {
  return [
    "ご連絡ありがとうございます。",
    "",
    ctx.acknowledgementLine,
    "内容を真摯に受け止め、社内で確認いたします。",
    "事実関係を確認したうえで、今後の対応方針をご連絡いたします。",
    "",
    "確認前に断定したご案内は控えさせていただきますが、できるだけ丁寧に対応いたします。"
  ];
}

function buildGeneralReply(ctx) {
  return [
    "お問い合わせありがとうございます。",
    "",
    ctx.acknowledgementLine,
    ctx.caseStatusLine,
    "",
    "差し支えなければ、ご希望内容や現在の状況が分かるお写真をお送りください。確認して次のご案内をいたします。"
  ];
}

function detectInquiryTopics(text) {
  const normalized = normalizeText(text);
  return TOPIC_DEFINITIONS.filter((topic) =>
    topic.patterns.some((pattern) => normalized.includes(pattern))
  );
}

function buildTopicLabel(topics) {
  const primary = topics.find((topic) =>
    ["toilet", "kitchen", "bath", "washstand", "waterHeater", "leak", "clog"].includes(topic.key)
  );
  return primary?.label || "";
}

function buildRequestLabel(topics, analysis) {
  if (topics.some((topic) => topic.key === "estimate")) return "お見積り";
  if (topics.some((topic) => topic.key === "schedule") || analysis?.templateKey === "schedule") return "日程";
  if (topics.some((topic) => topic.key === "replacement")) return "交換";
  if (topics.some((topic) => topic.key === "repair")) return "修理・点検";
  if (topics.some((topic) => topic.key === "reform")) return "リフォーム";
  if (analysis?.needsSiteVisit) return "現地確認";
  return "お問い合わせ内容";
}

function buildAcknowledgementLine({ topics, topicLabel, requestLabel, analysis }) {
  if (analysis?.templateKey === "complaint") {
    const target = topicLabel ? `${topicLabel}の件` : "今回の件";
    return `${target}について、状況を確認いたします。`;
  }
  if (analysis?.templateKey === "legalReputation") {
    return "いただいた内容を確認いたしました。";
  }
  if (topics.some((topic) => topic.key === "leak")) {
    return "水漏れの件、承りました。";
  }
  if (topics.some((topic) => topic.key === "clog")) {
    return "詰まりの件、承りました。";
  }
  if (topicLabel && requestLabel && requestLabel !== "お問い合わせ内容") {
    return `${topicLabel}の${requestLabel}について承りました。`;
  }
  if (requestLabel === "お見積り") {
    return "お見積り・費用に関するご相談として承りました。";
  }
  if (requestLabel === "日程") {
    return "日程のご希望について承りました。";
  }
  return "お問い合わせ内容を確認いたしました。";
}

function buildDetailRequestLine({ topics, analysis }) {
  if (analysis?.templateKey === "schedule") {
    return "日程調整に必要な内容を確認してご案内いたします。";
  }
  if (topics.some((topic) => ["leak", "clog"].includes(topic.key))) {
    return "可能でしたら、該当箇所のお写真と、いつ頃からの症状かをお送りください。";
  }
  if (analysis?.needsSiteVisit || topics.some((topic) => ["toilet", "kitchen", "bath", "washstand", "waterHeater"].includes(topic.key))) {
    return "差し支えなければ、気になる箇所のお写真と、ご希望の時間帯をお送りください。";
  }
  return "確認に必要な点があれば、こちらからあらためてご連絡いたします。";
}

function buildCaseStatusLine({ hasCase, estimateStatus, constructionSchedule }) {
  if (estimateStatus) {
    return "お見積りの状況も確認したうえでご案内いたします。";
  }
  if (constructionSchedule) {
    return "工事予定との関係も確認し、無理のない形でご案内いたします。";
  }
  return hasCase
    ? "過去のやり取りも確認したうえでご案内いたします。"
    : "いただいた内容をもとに、確認に必要な点を整理いたします。";
}

function summarizeSiteVisitSlots(calendarInfo) {
  if (!Array.isArray(calendarInfo)) return [];
  if (calendarInfo.selectedOfferedSlot) {
    return [formatSlotLabel(calendarInfo.selectedOfferedSlot)];
  }
  const labels = calendarInfo
    .filter((calendar) => isSiteVisitStaff(calendar.staffName || calendar.name))
    .flatMap((calendar) =>
      (calendar.availableSlots || []).map((slot) => {
        return formatSlotLabel(slot);
      })
    );
  return [...new Set(labels)].slice(0, 4);
}

function formatSlotLabel(slot) {
  const start = new Date(slot.start);
  const end = new Date(slot.end || start.getTime() + 60 * 60 * 1000);
  const dateLabel = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    weekday: "short"
  }).format(start);
  const startTime = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit"
  }).format(start);
  const endTime = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit"
  }).format(end);
  return `${dateLabel} ${startTime}-${endTime}`;
}

function summarizeSchedulePreference(calendarInfo) {
  if (!Array.isArray(calendarInfo)) return emptySchedulePreference();
  const preference = calendarInfo.find((calendar) => calendar.preference)?.preference || {};
  return {
    weekdays: Array.isArray(preference.weekdays) ? preference.weekdays : [],
    explicitDates: Array.isArray(preference.explicitDates) ? preference.explicitDates : [],
    hours: Array.isArray(preference.hours) ? preference.hours : [],
    availableAfterMinutes:
      Number.isFinite(preference.availableAfterMinutes) ? preference.availableAfterMinutes : null,
    availableBeforeMinutes:
      Number.isFinite(preference.availableBeforeMinutes) ? preference.availableBeforeMinutes : null,
    exactMinutes: Number.isFinite(preference.exactMinutes) ? preference.exactMinutes : null
  };
}

function buildNoSlotLine(preference) {
  const hasPreference =
    preference.weekdays.length ||
    preference.explicitDates.length ||
    preference.hours.length ||
    preference.availableAfterMinutes != null ||
    preference.availableBeforeMinutes != null ||
    preference.exactMinutes != null;
  if (!hasPreference) return "";

  const closedOnly =
    (preference.weekdays.length > 0 && preference.weekdays.every((day) => day === 0 || day === 1)) ||
    (preference.explicitDates.length > 0 && preference.explicitDates.every((date) => isClosedDateKey(date)));

  if (closedOnly) {
    return "日曜・月曜は定休日のため、火曜から土曜の営業時間内（10:00-19:00）で候補日を確認いたします。";
  }

  return "ご希望に近い日程を確認いたしましたが、現時点で自動候補が見つかりませんでした。空き状況を確認して、あらためて候補日をご案内いたします。";
}

function emptySchedulePreference() {
  return {
    weekdays: [],
    explicitDates: [],
    hours: [],
    availableAfterMinutes: null,
    availableBeforeMinutes: null,
    exactMinutes: null
  };
}

function formatSchedulePreference(preference) {
  const parts = [];
  if (preference.explicitDates.length === 1) {
    parts.push(formatDateKeyForCustomer(preference.explicitDates[0]));
  } else if (preference.weekdays.length) {
    parts.push(preference.weekdays.map((day) => "日月火水木金土"[day]).filter(Boolean).join("・") + "曜日");
  }

  if (preference.availableAfterMinutes != null) {
    parts.push(`${formatMinutes(preference.availableAfterMinutes)}以降`);
  } else if (preference.availableBeforeMinutes != null) {
    parts.push(`${formatMinutes(preference.availableBeforeMinutes)}まで`);
  } else if (preference.exactMinutes != null) {
    parts.push(`${formatMinutes(preference.exactMinutes)}ごろ`);
  } else if (preference.hours.length === 1) {
    parts.push(`${String(preference.hours[0]).padStart(2, "0")}:00ごろ`);
  }

  return parts.join(" ");
}

function formatDateKeyForCustomer(dateKey) {
  const [year, month, day] = String(dateKey || "").split("-").map(Number);
  if (!year || !month || !day) return "";
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = "日月火水木金土"[date.getUTCDay()];
  return `${month}月${day}日（${weekday}）`;
}

function formatMinutes(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function isClosedDateKey(dateKey) {
  const [year, month, day] = String(dateKey || "").split("-").map(Number);
  if (!year || !month || !day) return false;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 || weekday === 1;
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

function hasDateOrTimeExpression(text) {
  return (
    /\d{1,2}[月\/.-]\d{1,2}日?/.test(text) ||
    /\d{1,2}日/.test(text) ||
    /(?:日曜|月曜|火曜|水曜|木曜|金曜|土曜|日曜日|月曜日|火曜日|水曜日|木曜日|金曜日|土曜日|平日|土日|週末)/.test(text) ||
    /(?:[01]?\d|2[0-3])(?::[0-5]\d|時)/.test(text) ||
    /(?:午前|午後|夕方|朝|昼|以降|から)/.test(text)
  );
}
