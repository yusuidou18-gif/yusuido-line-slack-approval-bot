import http from "node:http";
import { URLSearchParams } from "node:url";
import { getConfig } from "./config.js";
import { readRawBody, sendJson, sendText } from "./http.js";
import { verifyLineSignature, verifySlackSignature, createId } from "./security.js";
import { findCalendarAvailability, findDriveCaseInfo } from "./google.js";
import { analyzeMessage, buildReplyDraft } from "./rules.js";
import { pushLineMessage, extractTextEvents } from "./line.js";
import { openRevisionModal, postApprovalRequest, updateSlackMessage } from "./slack.js";
import { getRequest, saveRequest, updateRequest } from "./storage.js";

const config = getConfig();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, service: "yusuido-line-slack-approval-bot" });
    }

    if (req.method === "POST" && url.pathname === "/webhooks/line") {
      return await handleLineWebhook(req, res);
    }

    if (req.method === "POST" && url.pathname === "/webhooks/slack/actions") {
      return await handleSlackAction(req, res);
    }

    sendJson(res, 404, { ok: false, error: "not_found" });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

server.listen(config.port, () => {
  console.log(`Yusuido approval bot listening on http://localhost:${config.port}`);
});

async function handleLineWebhook(req, res) {
  const rawBody = await readRawBody(req);
  const signature = req.headers["x-line-signature"];

  if (
    config.line.channelSecret &&
    !verifyLineSignature(config.line.channelSecret, rawBody, signature)
  ) {
    return sendJson(res, 401, { ok: false, error: "invalid_line_signature" });
  }

  const payload = JSON.parse(rawBody.toString("utf8"));
  const events = extractTextEvents(payload);

  for (const event of events) {
    await processLineTextEvent(event);
  }

  sendJson(res, 200, { ok: true });
}

async function processLineTextEvent(event) {
  const text = event.message.text;
  const sourceUserId = event.source?.userId || "";

  const caseInfo = await safe("Google Drive search", () =>
    findDriveCaseInfo(config, text, sourceUserId)
  );
  const calendarInfo = await safe("Google Calendar search", () =>
    findCalendarAvailability(config)
  );
  const analysis = analyzeMessage(text, caseInfo);

  const staffName = detectStaffName(caseInfo);
  const staffSlackUserId = staffName ? config.slack.staffUserIds[staffName] : "";
  const request = {
    id: createId("approval"),
    createdAt: new Date().toISOString(),
    status: "pending",
    lineUserId: sourceUserId,
    replyToken: event.replyToken,
    customerMessage: text,
    customerName: detectCustomerName(text),
    caseId: detectCaseId(text),
    customerType: analysis.isOb ? "OB" : "新規/未確認",
    staffName: staffName || "未確認",
    staffSlackUserId,
    caseStatus: "未確認",
    urgency: analysis.urgency,
    presidentRequired: analysis.presidentRequired,
    reason: buildReason(analysis, caseInfo, calendarInfo),
    replyDraft: buildReplyDraft({ text, analysis, config }),
    approvals: {
      staff: null,
      president: null
    },
    history: [
      {
        at: new Date().toISOString(),
        type: "created",
        note: "LINEメッセージから承認依頼を作成"
      }
    ],
    google: {
      drive: caseInfo,
      calendar: summarizeCalendar(calendarInfo)
    }
  };

  await saveRequest(request);
  await postApprovalRequest(config, request);
}

async function handleSlackAction(req, res) {
  const rawBody = await readRawBody(req);
  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];

  if (
    config.slack.signingSecret &&
    !verifySlackSignature(config.slack.signingSecret, rawBody, timestamp, signature)
  ) {
    return sendJson(res, 401, { ok: false, error: "invalid_slack_signature" });
  }

  const params = new URLSearchParams(rawBody.toString("utf8"));
  const payload = JSON.parse(params.get("payload"));

  if (payload.type === "view_submission" && payload.view?.callback_id === "revision_request") {
    return await handleRevisionSubmission(payload, res);
  }

  const action = payload.actions?.[0];
  const requestId = action?.value;
  const actionId = action?.action_id;
  const userId = payload.user?.id;

  if (!requestId || !actionId) {
    return sendText(res, 400, "Invalid action");
  }

  if (actionId === "revise") {
    const request = await getRequest(requestId);
    if (!request) return sendText(res, 404, "Request not found");
    await updateRequest(requestId, (current) => ({
      ...current,
      status: "revision_requested",
      history: [
        ...current.history,
        {
          at: new Date().toISOString(),
          type: "revise",
          userId,
          note: "Slackで修正依頼モーダルを開始"
        }
      ]
    }));
    await openRevisionModal(config, payload.trigger_id, request);
    return sendText(res, 200, "修正内容を入力してください。");
  }

  const updated = await updateRequest(requestId, (request) =>
    applySlackAction(request, actionId, userId)
  );

  if (!updated) return sendText(res, 404, "Request not found");

  if (updated.status === "approved_ready_to_send" && !updated.sentAt) {
    await pushLineMessage(config, updated.lineUserId, updated.replyDraft);
    await updateRequest(requestId, (request) => ({
      ...request,
      status: "sent",
      sentAt: new Date().toISOString(),
      history: [
        ...request.history,
        {
          at: new Date().toISOString(),
          type: "line_sent",
          note: "担当者と社長の承認後に公式LINEへ送信"
        }
      ]
    }));
    await updateSlackMessage(config, payload, `送信完了: ${requestId}`);
    return sendText(res, 200, "承認が揃ったためLINEへ送信しました。");
  }

  if (updated.status === "rejected") {
    await updateSlackMessage(config, payload, `却下済み: ${requestId}`);
    return sendText(res, 200, "却下として記録しました。LINE送信は行いません。");
  }

  sendText(res, 200, "承認を記録しました。もう一方の承認待ちです。");
}

async function handleRevisionSubmission(payload, res) {
  const requestId = payload.view.private_metadata;
  const values = payload.view.state.values;
  const replyDraft = values.reply_block.reply_text.value.trim();
  const reasonText = values.reason_block.reason_text.value?.trim() || "";
  const userId = payload.user?.id;

  if (!replyDraft) {
    return sendJson(res, 200, {
      response_action: "errors",
      errors: {
        reply_block: "修正後の返信案を入力してください。"
      }
    });
  }

  const updated = await updateRequest(requestId, (request) => ({
    ...request,
    status: "pending",
    replyDraft,
    approvals: { staff: null, president: null },
    reason: reasonText ? `${request.reason}。修正理由: ${reasonText}` : request.reason,
    history: [
      ...request.history,
      {
        at: new Date().toISOString(),
        type: "revision_submitted",
        userId,
        note: reasonText || "修正後の返信案を反映し、再承認依頼"
      }
    ]
  }));

  if (updated) await postApprovalRequest(config, updated);
  return sendJson(res, 200, { response_action: "clear" });
}

function applySlackAction(request, actionId, userId) {
  const now = new Date().toISOString();
  const historyItem = { at: now, type: actionId, userId };

  if (actionId === "reject") {
    return {
      ...request,
      status: "rejected",
      history: [...request.history, { ...historyItem, note: "Slackで却下" }]
    };
  }

  if (actionId !== "approve") return request;

  const isPresident = userId && userId === config.slack.presidentUserId;
  const officeUserIds = new Set([
    config.slack.officeUserId,
    ...(config.slack.officeUserIds || [])
  ].filter(Boolean));
  const configuredStaffUserIds = new Set(Object.values(config.slack.staffUserIds || {}).filter(Boolean));
  const isStaff =
    userId &&
    (userId === request.staffSlackUserId ||
      (!request.staffSlackUserId &&
        (officeUserIds.has(userId) || configuredStaffUserIds.has(userId))));

  const approvals = { ...request.approvals };
  if (isPresident) approvals.president = { userId, at: now };
  if (isStaff) approvals.staff = { userId, at: now };

  const ready = Boolean(approvals.staff && approvals.president);
  return {
    ...request,
    approvals,
    status: ready ? "approved_ready_to_send" : "pending",
    history: [
      ...request.history,
      {
        ...historyItem,
        note: ready ? "担当者と社長の承認が完了" : "承認を記録"
      }
    ]
  };
}

async function safe(label, fn) {
  try {
    return await fn();
  } catch (error) {
    console.error(`${label} failed:`, error.message);
    return { error: error.message };
  }
}

function buildReason(analysis, caseInfo, calendarInfo) {
  const parts = [analysis.reason];
  if (caseInfo?.error) parts.push(`Google Drive確認エラー: ${caseInfo.error}`);
  if (calendarInfo?.error) parts.push(`Googleカレンダー確認エラー: ${calendarInfo.error}`);
  return parts.join("。");
}

function summarizeCalendar(calendarInfo) {
  if (!Array.isArray(calendarInfo)) return calendarInfo;
  return calendarInfo.map((calendar) => ({
    calendarId: calendar.calendarId,
    eventCount: calendar.events.length,
    nextEvents: calendar.events.slice(0, 3).map((event) => ({
      summary: event.summary,
      start: event.start
    }))
  }));
}

function detectCustomerName(text) {
  const match = text.match(/([一-龥ぁ-んァ-ン]{2,8})(様|さん|さま)/);
  return match ? `${match[1]}様` : "未確認";
}

function detectCaseId(text) {
  const match = text.match(/[A-Z]{1,5}-?\d{3,}/i);
  return match ? match[0] : "未確認";
}

function detectStaffName(caseInfo) {
  const files = caseInfo?.matchedFiles || [];
  const joined = files.map((file) => file.name).join(" ");
  const match = joined.match(/担当[:：_\-\s]?([一-龥ぁ-んァ-ン]{2,6})/);
  return match ? match[1] : "";
}
