import { postApprovalRequest } from "../src/slack.js";
import { getConfig } from "../src/config.js";

const config = getConfig();
const now = new Date().toISOString();

const request = {
  id: `slack-test-${Date.now()}`,
  createdAt: now,
  status: "pending",
  lineUserId: "test-line-user",
  customerMessage: "Slack通知の疎通テストです。実際のお客様メッセージではありません。",
  customerName: "疎通テスト",
  caseId: "TEST",
  customerType: "テスト",
  staffName: "未確認",
  staffSlackUserId: "",
  caseStatus: "テスト",
  urgency: "低",
  presidentRequired: false,
  reason: "Slack通知経路の疎通確認。実際のLINE返信は行いません。",
  replyDraft: [
    "お問い合わせありがとうございます。",
    "",
    "こちらはSlack通知の疎通テストです。",
    "実際のお客様へ送信する返信ではありません。"
  ].join("\n"),
  approvals: {
    staff: null,
    president: null
  },
  history: [
    {
      at: now,
      type: "slack_post_test",
      note: "Manual Slack post test"
    }
  ]
};

await postApprovalRequest(config, request);
console.log(`Slack post test completed: ${request.id}`);
