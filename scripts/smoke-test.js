import { analyzeMessage, buildReplyDraft } from "../src/rules.js";
import { getConfig } from "../src/config.js";

const config = getConfig();
const samples = [
  "以前工事してもらったキッチン下から水漏れしています。今日見てもらえますか？",
  "見積について相談したいです。現地確認は可能ですか？",
  "金額を少し値引きしてもらえませんか？",
  "工事内容について不満があります。説明してください。"
];

for (const text of samples) {
  const analysis = analyzeMessage(text, null);
  const replyDraft = buildReplyDraft({ text, analysis, config });
  console.log("----");
  console.log(`message: ${text}`);
  console.log(`urgency: ${analysis.urgency}`);
  console.log(`presidentRequired: ${analysis.presidentRequired ? "yes" : "no"}`);
  console.log("replyDraft:");
  console.log(replyDraft);
}
