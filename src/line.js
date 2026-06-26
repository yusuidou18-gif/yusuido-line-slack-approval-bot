import { postJson } from "./http.js";

export async function pushLineMessage(config, to, text) {
  if (!config.line.channelAccessToken) {
    console.log("[LINE push skipped]", { to, text });
    return { ok: true, fallback: true };
  }

  const response = await postJson(
    "https://api.line.me/v2/bot/message/push",
    {
      to,
      messages: [{ type: "text", text }]
    },
    { authorization: `Bearer ${config.line.channelAccessToken}` }
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
