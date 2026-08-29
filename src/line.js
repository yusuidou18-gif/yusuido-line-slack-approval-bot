import { postJson } from "./http.js";

export async function pushLineMessage(config, to, text, retryKey = "") {
  if (!config.line.channelAccessToken) {
    console.log("[LINE push skipped]", { retryKey, textLength: String(text || "").length });
    return { ok: true, fallback: true };
  }

  const response = await postJson(
    "https://api.line.me/v2/bot/message/push",
    {
      to,
      messages: [{ type: "text", text }]
    },
    {
      authorization: `Bearer ${config.line.channelAccessToken}`,
      ...(retryKey ? { "X-Line-Retry-Key": retryKey } : {})
    }
  );

  if (Object.hasOwn(response, "ok") && !response.ok) {
    throw new Error(`LINE push error: ${response.message || response.error || "unknown_error"}`);
  }

  return response;
}

export function extractTextEvents(payload) {
  return (payload.events || []).filter(
    (event) => event.type === "message" && event.message?.type === "text"
  );
}
