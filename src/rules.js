const HIGH_KEYWORDS = [
  "水漏れ",
  "漏水",
  "漏電",
  "使えない",
  "使用不能",
  "怒",
  "不満",
  "苦情",
  "納得",
  "クレーム",
  "返金",
  "訴",
  "弁護士",
  "口コミ",
  "SNS",
  "至急",
  "緊急",
  "今日中",
  "トラブル",
  "支払い"
];

const MEDIUM_KEYWORDS = [
  "見積",
  "現調",
  "下見",
  "日程",
  "工事",
  "修理",
  "点検",
  "相談",
  "追加"
];

const PRESIDENT_REQUIRED_KEYWORDS = [
  "値引",
  "割引",
  "返金",
  "クレーム",
  "不満",
  "苦情",
  "納得",
  "怒",
  "トラブル",
  "支払い",
  "訴",
  "弁護士",
  "口コミ",
  "SNS",
  "できるか",
  "対応可能",
  "今日来"
];

export function analyzeMessage(text, caseInfo) {
  const normalized = String(text || "");
  const highHit = HIGH_KEYWORDS.find((keyword) => normalized.includes(keyword));
  const mediumHit = MEDIUM_KEYWORDS.find((keyword) => normalized.includes(keyword));
  const presidentHit = PRESIDENT_REQUIRED_KEYWORDS.find((keyword) =>
    normalized.includes(keyword)
  );

  const urgency = highHit ? "高" : mediumHit ? "中" : "低";
  const presidentRequired = Boolean(highHit || presidentHit);
  const isOb = /以前|前回|また|いつも|OB|リピート/.test(normalized);

  const reasons = [];
  if (highHit) reasons.push(`「${highHit}」を含むため緊急度を高と判定`);
  if (!highHit && mediumHit) reasons.push(`「${mediumHit}」を含むため確認・調整が必要`);
  if (presidentHit) reasons.push(`「${presidentHit}」を含むため社長確認が必要`);
  if (isOb) reasons.push("OB顧客の可能性があるため優先対応");
  if (caseInfo?.matchedFiles?.length) reasons.push("Google Driveに候補案件情報あり");
  if (!reasons.length) reasons.push("一般問い合わせとして一次返信案を作成");

  return {
    urgency,
    presidentRequired,
    isOb,
    reason: reasons.join("。")
  };
}

export function buildReplyDraft({ text, analysis, config }) {
  const phoneLine = config.companyPhone
    ? `\n\nお急ぎの場合は、お電話（${config.companyPhone}）でもご連絡ください。`
    : "\n\nお急ぎの場合は、お電話でもご連絡ください。";

  if (analysis.urgency === "高") {
    if (/クレーム|不満|苦情|納得|怒|トラブル|返金|支払い|口コミ|SNS|訴|弁護士/.test(text)) {
      return [
        "ご連絡ありがとうございます。",
        "",
        "このたびはご不安、ご不快な思いをおかけし申し訳ございません。",
        "内容を社内で確認し、担当者よりあらためてご連絡いたします。",
        "",
        "確認まで少々お時間をいただけますと幸いです。"
      ].join("\n");
    }

    return [
      "ご連絡ありがとうございます。",
      "",
      "ご不安な状況かと存じます。",
      "至急担当者に確認いたします。",
      phoneLine.trim(),
      "",
      "状況を確認のうえ、対応についてあらためてご案内いたします。"
    ].join("\n");
  }

  if (/値引|割引/.test(text)) {
    return [
      "ご相談ありがとうございます。",
      "",
      "金額に関する内容のため、社内で確認のうえご案内いたします。",
      "現時点では確定したお返事ができかねますが、担当者に確認いたします。",
      "",
      "少々お待ちいただけますと幸いです。"
    ].join("\n");
  }

  if (/現調|下見|見積|工事|修理|点検/.test(text)) {
    return [
      "お問い合わせありがとうございます。",
      "",
      "詳しい状況を確認したうえでご案内できればと思います。",
      "必要に応じて、現地確認の日程をご相談させてください。",
      "",
      "担当者に確認のうえ、あらためてご連絡いたします。"
    ].join("\n");
  }

  if (analysis.isOb) {
    return [
      "いつもありがとうございます。",
      "",
      "ご相談内容を確認いたしました。",
      "過去のご対応内容も確認のうえ、担当者よりあらためてご案内いたします。",
      "",
      "少々お時間をいただけますと幸いです。"
    ].join("\n");
  }

  return [
    "お問い合わせありがとうございます。",
    "",
    "内容を確認いたしました。",
    "詳細を確認のうえ、担当者よりあらためてご案内いたします。",
    "",
    "少々お時間をいただけますと幸いです。"
  ].join("\n");
}
