import { analyzeMessage, buildReplyDraft } from "../src/rules.js";
import { getConfig } from "../src/config.js";

const config = getConfig();
const samples = [
  {
    label: "緊急: 水漏れ",
    text: "以前工事してもらったキッチン下から水漏れしています。今日中に見てもらえますか？",
    caseInfo: { case: { customerType: "OB" }, matchedFiles: [{ name: "OB案件" }] }
  },
  {
    label: "クレーム",
    text: "工事後なのに直っていません。説明もなく納得できないです。",
    caseInfo: { case: { complaintHistory: "なし" }, matchedFiles: [{ name: "案件" }] }
  },
  {
    label: "値引き",
    text: "見積金額が高いので、少し値引きしてもらえませんか？",
    caseInfo: null
  },
  {
    label: "現調",
    text: "トイレ交換の見積をお願いしたいです。現地調査は可能ですか？",
    caseInfo: null
  },
  {
    label: "日程調整",
    text: "工事日の時間を変更したいです。いつなら空いていますか？",
    caseInfo: { case: { caseStatus: "工事予定あり" }, matchedFiles: [{ name: "工事予定案件" }] }
  }
];

for (const sample of samples) {
  const analysis = analyzeMessage(sample.text, sample.caseInfo);
  const replyDraft = buildReplyDraft({ text: sample.text, analysis, config });
  console.log("----");
  console.log(`case: ${sample.label}`);
  console.log(`message: ${sample.text}`);
  console.log(`urgency: ${analysis.urgency}`);
  console.log(`presidentRequired: ${analysis.presidentRequired ? "yes" : "no"}`);
  console.log(`templateKey: ${analysis.templateKey}`);
  console.log(`reason: ${analysis.reason}`);
  console.log("replyDraft:");
  console.log(replyDraft);
}
