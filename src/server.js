import http from "node:http";
import { URLSearchParams } from "node:url";
import { getConfig } from "./config.js";
import { readRawBody, sendJson, sendText } from "./http.js";
import { verifyLineSignature, verifySlackSignature, createId, createUuid } from "./security.js";
import { findCalendarAvailability, findDriveCaseInfo, verifyCalendarSlotAvailable } from "./google.js";
import { analyzeMessage, buildReplyDraft } from "./rules.js";
import { replyLineMessage, pushLineMessage, extractTextEvents } from "./line.js";
import { openRevisionModal, postApprovalRequest, updateSlackMessage } from "./slack.js";
import { audit, maskId } from "./audit.js";
import { createDraftMetadata, validateReplyDraft } from "./draft.js";
import { generateLlmReplyDraft } from "./llm.js";
import {
  appendConversationMessage,
  claimRequestForSending,
  getConversationByLineUser,
  getCustomerProfileByLineUser,
  getRequest,
  getRequestByLineMessageId,
  invalidatePendingRequestsForLineUser,
  readRequests,
  saveRequest,
  updateConversation,
  upsertCustomerProfile,
  updateRequest
} from "./storage.js";

const config = getConfig();
assertProductionSecrets(config);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, service: "yusuido-line-slack-approval-bot" });
    }

    if (req.method === "GET" && url.pathname === "/health/deep") {
      return await handleDeepHealth(res);
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

async function handleDeepHealth(res) {
  const requests = await readRequests();
  const values = Object.values(requests);
  const counts = values.reduce((acc, request) => {
    acc[request.status || "unknown"] = (acc[request.status || "unknown"] || 0) + 1;
    return acc;
  }, {});
  const required = {
    lineChannelSecret: Boolean(config.line.channelSecret),
    lineAccessToken: Boolean(config.line.channelAccessToken),
    slackSigningSecret: Boolean(config.slack.signingSecret),
    slackBotToken: Boolean(config.slack.botToken),
    slackChannelId: Boolean(config.slack.channelId),
    googleClientEmail: Boolean(config.google.clientEmail),
    googlePrivateKey: Boolean(config.google.privateKey),
    googleDriveFolderId: Boolean(config.google.driveFolderId),
    googleCalendarIds: Boolean(config.google.calendarIds.length)
  };
  const missing = Object.entries(required)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);

  sendJson(res, missing.length ? 503 : 200, {
    ok: missing.length === 0,
    service: "yusuido-line-slack-approval-bot",
    missing,
    requestCounts: counts,
    pendingOlderThan30Min: countOlderThan(values, ["pending", "revision_requested"], 30),
    sendFailures: counts.send_failed || 0,
    slotUnavailable: counts.slot_unavailable || 0
  });
}

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
  console.log("[LINE webhook received]", {
    eventCount: payload.events?.length || 0,
    textEventCount: events.length
  });

  for (const event of events) {
    await processLineTextEvent(event);
  }

  sendJson(res, 200, { ok: true });
}

async function processLineTextEvent(event) {
  const text = event.message.text;
  const sourceUserId = event.source?.userId || "";
  const draftId = createId("draft");
  const now = new Date();
  const lineMessageId = event.message?.id || "";
  console.log("[LINE text event start]", {
    lineUserId: maskId(sourceUserId),
    lineMessageId,
    messageLength: text.length
  });
  await audit("line_message_received", {
    lineUserId: sourceUserId,
    lineMessageId,
    messageLength: text.length
  });

  const previousConversation = await getConversationByLineUser(sourceUserId);
  const duplicateRequest = lineMessageId ? await getRequestByLineMessageId(lineMessageId) : null;
  if (
    lineMessageId &&
    (previousConversation?.processedLineMessageIds?.includes(lineMessageId) || duplicateRequest)
  ) {
    await audit("line_message_duplicate_skipped", { lineUserId: sourceUserId, lineMessageId });
    console.log("[LINE duplicate skipped]", { lineMessageId, lineUserId: maskId(sourceUserId) });
    return;
  }

  await appendConversationMessage(sourceUserId, {
    at: now.toISOString(),
    direction: "inbound",
    lineMessageId,
    text
  });

  const savedProfile = await getCustomerProfileByLineUser(sourceUserId);
  const caseInfo = await safe("Google Drive search", () =>
    findDriveCaseInfo(config, text, sourceUserId)
  );
  const effectiveCaseInfo = mergeSavedProfileIntoCaseInfo(caseInfo, savedProfile);
  const selectedOfferedSlot = matchPreviousOfferedSlot(text, previousConversation);
  const calendarInfo = await safe("Google Calendar search", () =>
    findCalendarAvailability(config, effectiveCaseInfo, text)
  );
  if (Array.isArray(calendarInfo) && selectedOfferedSlot) {
    calendarInfo.selectedOfferedSlot = selectedOfferedSlot;
  }
  const analysis = analyzeMessage(text, effectiveCaseInfo);

  const staffName = detectStaffName(effectiveCaseInfo);
  const staffSlackUserId = staffName ? config.slack.staffUserIds[staffName] : "";
  const driveCase = effectiveCaseInfo?.case || {};
  if (driveCase.customerName || driveCase.caseId) {
    await upsertCustomerProfile(sourceUserId, {
      customerName: driveCase.customerName || "",
      primaryCaseId: driveCase.caseId || "",
      customerType: driveCase.customerType || "",
      staffName: driveCase.staffName || "",
      matchConfidence: caseInfo?.matchConfidence || "medium",
      lastMatchedAt: now.toISOString()
    });
  }
  const ruleReplyDraft = buildReplyDraft({ text, analysis, config, caseInfo: effectiveCaseInfo, calendarInfo });
  const llmResult = await generateLlmReplyDraft(config, {
    customerMessage: text,
    ruleReplyDraft,
    analysis,
    caseInfo: summarizeCaseForLlm(effectiveCaseInfo),
    calendar: summarizeCalendar(calendarInfo),
    conversation: summarizeConversationForLlm(previousConversation)
  });
  const replyDraft = llmResult.ok ? llmResult.customerReply : ruleReplyDraft;
  const draftValidation = validateReplyDraft(replyDraft, { allowGeneric: false });
  const generationErrors = [
    ...draftValidation.errors,
    ...(config.llm.required && !llmResult.ok ? [`LLM生成失敗: ${llmResult.error}`] : [])
  ];
  const draftOk = generationErrors.length === 0;
  await invalidatePendingRequestsForLineUser(
    sourceUserId,
    "新しいLINEメッセージを受信したため旧返信案を無効化"
  );
  const request = {
    id: createId("approval"),
    createdAt: now.toISOString(),
    status: draftOk ? "pending" : "generation_failed",
    lineMessageId,
    lineUserId: sourceUserId,
    replyToken: event.replyToken,
    customerMessage: text,
    customerName: driveCase.customerName || detectCustomerName(text),
    caseId: driveCase.caseId || detectCaseId(text),
    customerType: driveCase.customerType || (analysis.isOb ? "OB" : "\u672a\u78ba\u8a8d"),
    staffName: staffName || "\u672a\u78ba\u8a8d",
    staffSlackUserId,
    caseStatus: driveCase.caseStatus || "\u672a\u78ba\u8a8d",
    urgency: analysis.urgency,
    presidentRequired: analysis.presidentRequired,
    reason: buildReason(analysis, caseInfo, calendarInfo),
    replyDraft,
    draft: {
      ...createDraftMetadata({
        id: draftId,
        version: 1,
        replyDraft,
        customerMessage: text,
        caseId: driveCase.caseId || "",
        lineMessageId,
        now
      }),
      status: draftOk ? "pending" : "generation_failed",
      validationErrors: generationErrors
    },
    sendBlockedReason: draftOk ? "" : generationErrors.join(" / "),
    sendRetryKey: createUuid(),
    llm: {
      used: Boolean(llmResult.ok),
      skipped: Boolean(llmResult.skipped),
      required: Boolean(config.llm.required),
      responseId: llmResult.responseId || "",
      error: llmResult.ok ? "" : llmResult.error || "",
      judgementReason: llmResult.judgementReason || "",
      confidence: llmResult.confidence || ""
    },
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
      drive: effectiveCaseInfo,
      calendar: summarizeCalendar(calendarInfo)
    },
    selectedOfferedSlot
  };

  await saveRequest(request);
  await appendConversationMessage(sourceUserId, {
    at: now.toISOString(),
    direction: "system",
    type: "approval_created",
    requestId: request.id,
    draftId,
    lineMessageId
  });
  await updateConversation(sourceUserId, (conversation) => ({
    ...conversation,
    lastRequestId: request.id,
    lastDraftId: draftId,
    lastOfferedSlots: extractOfferedSlots(calendarInfo, request.id),
    updatedAt: now.toISOString()
  }));
  await postApprovalRequest(config, request);
  await audit("slack_approval_posted", {
    requestId: request.id,
    status: request.status,
    urgency: request.urgency,
    presidentRequired: request.presidentRequired,
    blocked: Boolean(request.sendBlockedReason)
  });
  console.log("[LINE text event completed]", {
    requestId: request.id,
    urgency: request.urgency,
    presidentRequired: request.presidentRequired
  });
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
  const actionValue = parseActionValue(action?.value);
  const requestId = actionValue.id;
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

  const currentBeforeAction = await getRequest(requestId);
  if (!currentBeforeAction) return sendText(res, 404, "Request not found");
  if (currentBeforeAction.sendBlockedReason && actionId === "approve") {
    await updateSlackMessage(config, payload, `送信不可: ${currentBeforeAction.sendBlockedReason}`);
    return sendText(res, 409, "この返信案は検証エラーがあるため送信しません。編集して再承認してください。");
  }
  if (!isCurrentDraftAction(currentBeforeAction, actionValue)) {
    await updateSlackMessage(config, payload, `無効な古い承認ボタンです: ${requestId}`);
    return sendText(res, 200, "この承認依頼は古い下書きのため送信しません。最新のSlack通知から承認してください。");
  }

  const updated = await updateRequest(requestId, (request) =>
    applySlackAction(request, actionId, userId, actionValue)
  );

  if (!updated) return sendText(res, 404, "Request not found");

  if (updated.status === "approved_ready_to_send" && !updated.sentAt) {
    const claimed = await claimRequestForSending(requestId);
    if (!claimed) {
      await updateSlackMessage(config, payload, `送信処理中または送信済みです。同じ承認では再送しません: ${requestId}`);
      return sendText(res, 200, "送信処理中または送信済みです。再送は行いません。");
    }

    if (claimed.selectedOfferedSlot) {
      const availability = await safe("Google Calendar slot recheck", () =>
        verifyCalendarSlotAvailable(config, claimed.selectedOfferedSlot)
      );
      if (!availability?.ok) {
        await updateRequest(requestId, (request) => ({
          ...request,
          status: "slot_unavailable",
          sendBlockedReason: availability?.reason || "承認時点で候補枠を再確認できませんでした",
          history: [
            ...request.history,
            {
              at: new Date().toISOString(),
              type: "slot_unavailable",
              note: availability?.reason || "承認時点で候補枠を再確認できませんでした"
            }
          ]
        }));
        await updateSlackMessage(config, payload, `日程候補が埋まった可能性があります: ${availability?.reason || "再確認失敗"}\nLINE送信は止めました。再提案してください。`);
        await audit("slot_unavailable_blocked_send", { requestId, reason: availability?.reason || "" });
        return sendText(res, 200, "日程候補が埋まった可能性があるため、LINE送信を止めました。");
      }
    }
    try {
      const lineSend = await sendApprovedLineMessage(config, claimed, requestId);
      claimed.lineSendMethod = lineSend.method || "push";
    } catch (error) {
      await updateRequest(requestId, (request) => ({
        ...request,
        status: "send_failed",
        sendFailedAt: new Date().toISOString(),
        sendError: error.message,
        history: [
          ...request.history,
          {
            at: new Date().toISOString(),
            type: "line_send_failed",
            note: error.message
          }
        ]
      }));
      await updateSlackMessage(config, payload, `LINE送信失敗: ${error.message}\n手動対応または再送判断が必要です。`);
      await audit("line_send_failed", { requestId, error: error.message });
      return sendText(res, 200, "LINE送信に失敗しました。Slackに復旧案内を追記しました。");
    }
    await updateRequest(requestId, (request) => ({
      ...request,
      status: "sent",
      sentAt: new Date().toISOString(),
      draft: { ...(request.draft || {}), status: "sent" },
      history: [
        ...request.history,
        {
          at: new Date().toISOString(),
          type: "line_sent",
          note: `承認後に公式LINEへ送信 (${claimed.lineSendMethod || "push"})`
        }
      ]
    }));
    await appendConversationMessage(claimed.lineUserId, {
      at: new Date().toISOString(),
      direction: "outbound",
      requestId,
      draftId: claimed.draft?.id || "",
      text: claimed.replyDraft
    });
    await audit("line_message_sent", {
      requestId,
      retryKey: claimed.sendRetryKey || requestId,
      method: claimed.lineSendMethod || "push"
    });
    await updateSlackMessage(config, payload, `送信完了: ${requestId}\n送信方法: ${claimed.lineSendMethod || "push"}`);
    return sendText(res, 200, "承認が揃ったためLINEへ送信しました。");
  }

  if (updated.status === "sent") {
    await updateSlackMessage(config, payload, `送信済みです。同じ承認では再送しません: ${requestId}`);
    return sendText(res, 200, "この返信案は送信済みです。再送は行いません。");
  }

  if (updated.status === "stale") {
    await updateSlackMessage(config, payload, `無効な古い承認依頼です。最新の通知を確認してください: ${requestId}`);
    return sendText(res, 200, "この承認依頼は古いため送信しません。");
  }

  if (updated.status === "rejected") {
    await updateSlackMessage(config, payload, `却下済み: ${requestId}`);
    return sendText(res, 200, "却下として記録しました。LINE送信は行いません。");
  }

  sendText(res, 200, "承認を記録しました。もう一方の承認待ちです。");
}

async function sendApprovedLineMessage(config, request, requestId) {
  if (canUseReplyToken(request)) {
    try {
      return await replyLineMessage(config, request.replyToken, request.replyDraft);
    } catch (error) {
      if (!isReplyTokenExpiredError(error)) throw error;
      await audit("line_reply_token_expired_fallback", { requestId, error: error.message });
    }
  }

  return await pushLineMessage(
    config,
    request.lineUserId,
    request.replyDraft,
    request.sendRetryKey || requestId
  );
}

function canUseReplyToken(request) {
  if (!request.replyToken || !request.createdAt) return false;
  const ageMs = Date.now() - new Date(request.createdAt).getTime();
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 55_000;
}

function isReplyTokenExpiredError(error) {
  const message = String(error?.message || "");
  return message.includes("Invalid reply token") || message.includes("reply token");
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

  const draftValidation = validateReplyDraft(replyDraft, { allowGeneric: false });
  if (!draftValidation.ok) {
    return sendJson(res, 200, {
      response_action: "errors",
      errors: {
        reply_block: draftValidation.errors.join(" / ")
      }
    });
  }

  const updated = await updateRequest(requestId, (request) => ({
    ...request,
    status: "pending",
    replyDraft,
    draft: {
      ...createDraftMetadata({
        id: createId("draft"),
        version: (request.draft?.version || 1) + 1,
        replyDraft,
        customerMessage: request.customerMessage,
        caseId: request.caseId,
        lineMessageId: request.lineMessageId,
        now: new Date()
      }),
      validationErrors: []
    },
    sendBlockedReason: "",
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

function applySlackAction(request, actionId, userId, actionValue = {}) {
  const now = new Date().toISOString();
  const historyItem = { at: now, type: actionId, userId };

  if (["stale", "sent", "rejected", "sending", "send_failed", "slot_unavailable", "generation_failed"].includes(request.status)) {
    return {
      ...request,
      history: [
        ...request.history,
        {
          ...historyItem,
          note: `現在のステータスが${request.status}のため送信しません`
        }
      ]
    };
  }

  if (actionId === "reject") {
    return {
      ...request,
      status: "rejected",
      history: [...request.history, { ...historyItem, note: "Slackで却下" }]
    };
  }

  if (actionId !== "approve") return request;

  if (!isCurrentDraftAction(request, actionValue)) {
    return {
      ...request,
      status: "stale",
      draft: { ...(request.draft || {}), status: "stale" },
      history: [
        ...request.history,
        { ...historyItem, note: "古い下書きへの承認のため送信しません" }
      ]
    };
  }

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

  const ready = request.presidentRequired
    ? Boolean(approvals.president)
    : Boolean(approvals.staff || approvals.president);
  return {
    ...request,
    approvals,
    status: ready ? "approved_ready_to_send" : "pending",
    history: [
      ...request.history,
      {
        ...historyItem,
        note: ready ? "必要な承認が完了" : "承認を記録"
      }
    ]
  };
}

function parseActionValue(value) {
  if (!value) return { id: "", draftId: "", version: 0 };
  try {
    const parsed = JSON.parse(value);
    return {
      id: parsed.id || "",
      draftId: parsed.draftId || parsed.draft_id || "",
      version: Number(parsed.version || 0)
    };
  } catch {
    return { id: value, draftId: "", version: 0 };
  }
}

function isCurrentDraftAction(request, actionValue) {
  if (!request?.draft) return true;
  if (request.status === "generation_failed") return false;
  if (request.draft.status === "stale") return false;
  if (request.draft.status === "generation_failed") return false;
  if (request.draft.expiresAt && new Date(request.draft.expiresAt) <= new Date()) return false;
  if (actionValue.draftId && actionValue.draftId !== request.draft.id) return false;
  if (actionValue.version && actionValue.version !== request.draft.version) return false;
  return true;
}

function extractSlackBlockText(payload, index) {
  const text = payload.message?.blocks?.[index]?.text?.text || "";
  return text.replace(/^\*.*?\*\n/s, "").replace(/^>/gm, "").trim();
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
  if (caseInfo?.note) parts.push(caseInfo.note);
  const slots = summarizeAvailableSlots(calendarInfo);
  if (slots.length) parts.push(`\u73fe\u8abf\u5019\u88dc: ${slots.join(" / ")}`);
  if (caseInfo?.error) parts.push(`Google Drive\u78ba\u8a8d\u30a8\u30e9\u30fc: ${caseInfo.error}`);
  if (calendarInfo?.error) parts.push(`Google\u30ab\u30ec\u30f3\u30c0\u30fc\u78ba\u8a8d\u30a8\u30e9\u30fc: ${calendarInfo.error}`);
  return parts.join("\u3002 ");
}

function summarizeAvailableSlots(calendarInfo) {
  if (!Array.isArray(calendarInfo)) return [];
  return calendarInfo
    .flatMap((calendar) =>
      (calendar.availableSlots || []).slice(0, 3).map((slot) => {
        const start = new Date(slot.start);
        const label = new Intl.DateTimeFormat("ja-JP", {
          timeZone: "Asia/Tokyo",
          month: "numeric",
          day: "numeric",
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit"
        }).format(start);
        return `${calendar.name || calendar.calendarId} ${label}`;
      })
    )
    .slice(0, 5);
}

function summarizeCalendar(calendarInfo) {
  if (!Array.isArray(calendarInfo)) return calendarInfo;
  const calendars = calendarInfo.map((calendar) => ({
    calendarId: calendar.calendarId,
    name: calendar.name,
    staffName: calendar.staffName,
    eventCount: calendar.events.length,
    availableSlots: calendar.availableSlots || [],
    nextEvents: calendar.events.slice(0, 3).map((event) => ({
      summary: event.summary,
      start: event.start
    }))
  }));
  calendars.selectedOfferedSlot = calendarInfo.selectedOfferedSlot || null;
  return calendars;
}

function summarizeCaseForLlm(caseInfo) {
  const data = caseInfo?.case || {};
  return {
    customerType: data.customerType || "",
    staffName: data.staffName || "",
    caseStatus: data.caseStatus || "",
    estimateStatus: data.estimateStatus || "",
    constructionSchedule: data.constructionSchedule || "",
    complaintHistory: data.complaintHistory || "",
    matchConfidence: caseInfo?.matchConfidence || ""
  };
}

function summarizeConversationForLlm(conversation) {
  return {
    recentMessages: (conversation?.messages || []).slice(-6).map((message) => ({
      at: message.at,
      direction: message.direction,
      type: message.type || "message",
      text: message.direction === "system" ? "" : message.text || ""
    })),
    lastOfferedSlots: conversation?.lastOfferedSlots || []
  };
}

function mergeSavedProfileIntoCaseInfo(caseInfo, profile) {
  if (!profile) return caseInfo;
  const current = caseInfo && !caseInfo.error ? caseInfo : {};
  const currentCase = current.case || {};
  return {
    ...current,
    matchedFiles: current.matchedFiles?.length
      ? current.matchedFiles
      : [
          {
            id: profile.id,
            name: "保存済みLINE顧客紐づけ",
            textPreview: "",
            extracted: {}
          }
        ],
    case: {
      customerName: currentCase.customerName || profile.customerName || "",
      caseId: currentCase.caseId || profile.primaryCaseId || "",
      customerType: currentCase.customerType || profile.customerType || "",
      staffName: currentCase.staffName || profile.staffName || "",
      caseStatus: currentCase.caseStatus || profile.caseStatus || "",
      estimateStatus: currentCase.estimateStatus || profile.estimateStatus || "",
      constructionSchedule: currentCase.constructionSchedule || profile.constructionSchedule || "",
      complaintHistory: currentCase.complaintHistory || profile.complaintHistory || ""
    },
    matchConfidence: current.matchConfidence || profile.matchConfidence || "saved_profile",
    note: current.note || "保存済みLINE顧客紐づけを参照"
  };
}

function matchPreviousOfferedSlot(text, conversation) {
  const slots = conversation?.lastOfferedSlots || [];
  if (!slots.length) return null;
  const normalized = String(text || "").normalize("NFKC");
  const timeMatch = normalized.match(/([01]?\d|2[0-3])(?:[:時]([0-5]\d))?/);
  const dayMatch = normalized.match(/(?:^|[^\d])(\d{1,2})日/);
  if (!timeMatch && !dayMatch) return null;

  const hour = timeMatch ? Number(timeMatch[1]) : null;
  const minute = timeMatch ? Number(timeMatch[2] || 0) : null;
  const day = dayMatch ? Number(dayMatch[1]) : null;
  const matches = slots.filter((slot) => {
    const start = new Date(slot.start);
    const parts = new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hour12: false
    }).formatToParts(start);
    const value = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
    if (day && value("day") !== day) return false;
    if (hour != null && value("hour") !== hour) return false;
    if (minute != null && value("minute") !== minute) return false;
    return true;
  });
  return matches.length === 1 ? matches[0] : null;
}

function extractOfferedSlots(calendarInfo, requestId) {
  if (!Array.isArray(calendarInfo)) return [];
  return calendarInfo
    .flatMap((calendar) =>
      (calendar.availableSlots || []).map((slot, index) => ({
        slotId: slot.slotId || `${requestId}_${calendar.calendarId || calendar.name}_${index}`,
        requestId,
        calendarId: calendar.calendarId,
        staffName: calendar.staffName || calendar.name || "",
        start: slot.start,
        end: slot.end,
        status: "available",
        checkedAt: calendar.checkedAt || new Date().toISOString(),
        expiresAt: calendar.expiresAt || new Date(Date.now() + 30 * 60 * 1000).toISOString()
      }))
    )
    .slice(0, 8);
}

function countOlderThan(requests, statuses, minutes) {
  const threshold = Date.now() - minutes * 60 * 1000;
  return requests.filter((request) => {
    if (!statuses.includes(request.status)) return false;
    const createdAt = new Date(request.createdAt || 0).getTime();
    return Number.isFinite(createdAt) && createdAt < threshold;
  }).length;
}

function detectCustomerName(text) {
  const match = text.match(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc]{2,12})(\u69d8|\u3055\u3093|\u3055\u307e)/u);
  return match ? `${match[1]}\u69d8` : "\u672a\u78ba\u8a8d";
}

function detectCaseId(text) {
  const match = text.match(/[A-Z]{1,5}-?\d{3,}/i);
  return match ? match[0] : "\u672a\u78ba\u8a8d";
}

function detectStaffName(caseInfo) {
  if (caseInfo?.case?.staffName) return caseInfo.case.staffName;
  const files = caseInfo?.matchedFiles || [];
  const joined = files.map((file) => `${file.name} ${file.textPreview || ""}`).join(" ");
  const match = joined.match(/(?:\u62c5\u5f53\u8005|\u55b6\u696d\u62c5\u5f53|\u62c5\u5f53|\u73fe\u8abf\u62c5\u5f53)\s*[\uff1a:\-\s]\s*([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc]{2,12})/u);
  return match ? match[1] : "";
}

function assertProductionSecrets(currentConfig) {
  if (!process.env.RENDER && process.env.NODE_ENV !== "production") return;
  const missing = [];
  if (!currentConfig.line.channelSecret) missing.push("LINE_CHANNEL_SECRET");
  if (!currentConfig.slack.signingSecret) missing.push("SLACK_SIGNING_SECRET");
  if (!currentConfig.line.channelAccessToken) missing.push("LINE_CHANNEL_ACCESS_TOKEN");
  if (!currentConfig.slack.botToken) missing.push("SLACK_BOT_TOKEN");
  if (missing.length) {
    throw new Error(`Production secrets are missing: ${missing.join(", ")}`);
  }
}
