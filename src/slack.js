import { postJson } from "./http.js";

export async function postApprovalRequest(config, request) {
  if (!config.slack.botToken || !config.slack.channelId) {
    console.log("[Slack post skipped: missing config]", {
      requestId: request.id,
      hasBotToken: Boolean(config.slack.botToken),
      hasChannelId: Boolean(config.slack.channelId)
    });
    console.log(formatSlackFallback(request));
    return { ok: true, fallback: true };
  }

  console.log("[Slack post start]", {
    requestId: request.id,
    channelId: config.slack.channelId,
    urgency: request.urgency,
    presidentRequired: request.presidentRequired
  });

  const response = await postJson(
    "https://slack.com/api/chat.postMessage",
    buildSlackMessage(config, request),
    { authorization: `Bearer ${config.slack.botToken}` }
  );

  if (!response.ok) {
    console.error("[Slack post failed]", {
      requestId: request.id,
      error: response.error
    });
    throw new Error(`Slack post error: ${response.error}`);
  }

  console.log("[Slack post success]", {
    requestId: request.id,
    channelId: response.channel,
    ts: response.ts
  });

  return response;
}

export async function updateSlackMessage(config, payload, text) {
  if (!config.slack.botToken || !payload.channel?.id || !payload.message?.ts) return;

  const originalBlocks = Array.isArray(payload.message.blocks) ? payload.message.blocks : [];
  const preservedBlocks = originalBlocks.filter((block) => block.block_id !== "approval_status");
  const statusText = `*ステータス更新*\n${text}\n元の承認依頼本文は記録として残しています。`;

  const response = await postJson(
    "https://slack.com/api/chat.update",
    {
      channel: payload.channel.id,
      ts: payload.message.ts,
      text: `${payload.message.text || "公式LINE返信案"}\n${text}`,
      blocks: [
        ...preservedBlocks,
        {
          type: "context",
          block_id: "approval_status",
          elements: [{ type: "mrkdwn", text: statusText }]
        }
      ]
    },
    { authorization: `Bearer ${config.slack.botToken}` }
  );

  if (!response.ok) throw new Error(`Slack update error: ${response.error}`);
}

export async function openRevisionModal(config, triggerId, request) {
  if (!config.slack.botToken || !triggerId) return;

  const response = await postJson(
    "https://slack.com/api/views.open",
    {
      trigger_id: triggerId,
      view: {
        type: "modal",
        callback_id: "revision_request",
        private_metadata: request.id,
        title: { type: "plain_text", text: "返信案の修正" },
        submit: { type: "plain_text", text: "再承認依頼" },
        close: { type: "plain_text", text: "キャンセル" },
        blocks: [
          {
            type: "input",
            block_id: "reply_block",
            label: { type: "plain_text", text: "修正後のAI返信案" },
            element: {
              type: "plain_text_input",
              action_id: "reply_text",
              multiline: true,
              initial_value: request.replyDraft.slice(0, 2900)
            }
          },
          {
            type: "input",
            block_id: "reason_block",
            optional: true,
            label: { type: "plain_text", text: "修正理由・メモ" },
            element: {
              type: "plain_text_input",
              action_id: "reason_text",
              multiline: true
            }
          }
        ]
      }
    },
    { authorization: `Bearer ${config.slack.botToken}` }
  );

  if (!response.ok) throw new Error(`Slack modal error: ${response.error}`);
}

export function buildSlackMessage(config, request) {
  const text = formatSlackFallback(request);
  const mentions = buildMentions(config, request);
  const approverLines = buildApproverLines(request);
  const warningBlock = request.sendBlockedReason
    ? [section(`*【送信不可・要修正】*\n${escapeMrkdwn(request.sendBlockedReason)}`)]
    : [];
  const scheduleBlock = buildScheduleBlock(request);
  const actionButtons = request.sendBlockedReason
    ? [button("編集して再承認", "revise", request), button("却下", "reject", request, "danger")]
    : [
        button("この本文をLINE送信", "approve", request, "primary"),
        button("編集して再承認", "revise", request),
        button("却下", "reject", request, "danger")
      ];

  return {
    channel: config.slack.channelId,
    text,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${mentions}\n*【公式LINE返信案｜承認依頼】*`
        }
      },
      {
        type: "section",
        fields: [
          field("顧客名", request.customerName),
          field("案件ID", request.caseId),
          field("新規/OB", request.customerType),
          field("担当者", request.staffName),
          field("ステータス", request.caseStatus),
          field("緊急度", request.urgency),
          field("社長確認", request.presidentRequired ? "必要" : "不要")
        ]
      },
      ...warningBlock,
      section(`*判断理由:*\n${request.reason}`),
      ...(scheduleBlock ? [scheduleBlock] : []),
      section(`*【顧客メッセージ】*\n>${escapeMrkdwn(request.customerMessage).replace(/\n/g, "\n>")}`),
      section(`*【AI返信案】*\n${request.replyDraft}`),
      section(
        "*【確認してほしい点】*\n・この返信で送信してよいか\n・金額/日程/対応可否に問題がないか\n・社長確認が必要な内容が含まれていないか"
      ),
      section(`*承認者:*\n${approverLines}`),
      {
        type: "actions",
        elements: actionButtons
      }
    ]
  };
}

function buildScheduleBlock(request) {
  const selected = request.selectedOfferedSlot;
  if (selected) {
    return section(`*【日程理解】*\n前回提示候補から選択: ${formatSlotForSlack(selected)}\n承認時にGoogleカレンダーを再確認します。`);
  }

  const calendars = Array.isArray(request.google?.calendar) ? request.google.calendar : [];
  const slots = calendars
    .flatMap((calendar) =>
      (calendar.availableSlots || []).slice(0, 3).map((slot) =>
        `・${formatSlotForSlack(slot)}（社内: ${escapeMrkdwn(slot.staffName || calendar.staffName || calendar.name || "未確認")}）`
      )
    )
    .slice(0, 6);
  if (!slots.length) return null;
  return section(`*【Googleカレンダー候補】*\n${slots.join("\n")}`);
}

function buildMentions(config, request) {
  const ids = new Set();
  if (request.staffSlackUserId) ids.add(request.staffSlackUserId);
  if (request.presidentRequired && config.slack.presidentUserId) {
    ids.add(config.slack.presidentUserId);
  }
  if (!request.staffSlackUserId && config.slack.officeUserId) ids.add(config.slack.officeUserId);
  if (!request.staffSlackUserId) {
    for (const id of config.slack.officeUserIds || []) ids.add(id);
  }
  return [...ids].map((id) => `<@${id}>`).join(" ");
}

function buildApproverLines(request) {
  const lines = ["・担当者"];
  if (request.presidentRequired) lines.push("・社長");
  return lines.join("\n");
}

function field(label, value) {
  return {
    type: "mrkdwn",
    text: `*${label}:*\n${value || "未確認"}`
  };
}

function section(text) {
  return {
    type: "section",
    text: { type: "mrkdwn", text }
  };
}

function formatSlotForSlack(slot) {
  const start = new Date(slot.start);
  const end = new Date(slot.end || start.getTime() + 60 * 60 * 1000);
  const dateLabel = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(start);
  const endTime = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit"
  }).format(end);
  return `${dateLabel}-${endTime}`;
}

function button(text, action, request, style) {
  return {
    type: "button",
    text: { type: "plain_text", text },
    value: buildActionValue(request),
    action_id: action,
    ...(style ? { style } : {})
  };
}

function buildActionValue(request) {
  if (typeof request === "string") return request;
  return JSON.stringify({
    id: request.id,
    draftId: request.draft?.id || request.id,
    version: request.draft?.version || 1
  });
}

function formatSlackFallback(request) {
  const approverLines = buildApproverLines(request);
  return `――――――――――

【公式LINE返信案｜承認依頼】

顧客名：${request.customerName || ""}
案件ID：${request.caseId || ""}
新規/OB：${request.customerType || ""}
担当者：${request.staffName || ""}
ステータス：${request.caseStatus || ""}
緊急度：${request.urgency || ""}
社長確認：${request.presidentRequired ? "必要" : "不要"}
判断理由：${request.reason || ""}

【顧客メッセージ】
「${request.customerMessage || ""}」

【AI返信案】
「${request.replyDraft || ""}」

【確認してほしい点】
・この返信で送信してよいか
・金額/日程/対応可否に問題がないか
・社長確認が必要な内容が含まれていないか

承認者：
${approverLines}

アクション：
［この本文をLINE送信］［編集して再承認］［却下］

――――――――――`;
}

function escapeMrkdwn(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
