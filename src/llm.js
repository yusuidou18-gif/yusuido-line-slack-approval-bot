const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export async function generateLlmReplyDraft(config, context) {
  if (!config.llm?.apiKey) {
    return { ok: false, skipped: true, error: "OPENAI_API_KEY is not set" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.llm.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: config.llm.model,
        temperature: 0.2,
        store: false,
        instructions: buildInstructions(),
        input: JSON.stringify(context)
      })
    });
    const data = await response.json();
    if (!response.ok) {
      return { ok: false, error: data.error?.message || response.statusText };
    }
    const parsed = parseJsonOutput(data.output_text || extractOutputText(data));
    const validation = validateLlmOutput(parsed);
    return validation.ok
      ? { ok: true, ...parsed, responseId: data.id }
      : { ok: false, error: validation.errors.join(" / "), raw: parsed };
  } catch (error) {
    return { ok: false, error: error.name === "AbortError" ? "LLM request timeout" : error.message };
  } finally {
    clearTimeout(timeout);
  }
}

function buildInstructions() {
  return [
    "あなたは株式会社湧水ホールディングス「湧水堂」の公式LINE返信支援AIです。",
    "顧客へ直接送信される本文案を作りますが、送信判断はSlack承認後のみです。",
    "金額、工期、値引き、対応可否、工事日、職人手配を確約しないでください。",
    "不明点は確認いたしますと表現してください。",
    "LINEで読みやすい短い日本語にしてください。",
    "スタッフ名、Google、Slack、案件ID、判断理由、社長確認などの社内情報を顧客本文に入れないでください。",
    "出力はJSONのみ。形式: {\"customerReply\":\"...\",\"judgementReason\":\"...\",\"confidence\":\"high|medium|low\",\"needsHumanAttention\":true|false}"
  ].join("\n");
}

function extractOutputText(data) {
  return (data.output || [])
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text || "")
    .join("\n");
}

function parseJsonOutput(text) {
  const trimmed = String(text || "").trim();
  const json = trimmed.match(/\{[\s\S]*\}/)?.[0] || trimmed;
  return JSON.parse(json);
}

function validateLlmOutput(value) {
  const errors = [];
  if (!value || typeof value !== "object") errors.push("LLM出力がJSONオブジェクトではありません");
  if (typeof value?.customerReply !== "string" || !value.customerReply.trim()) {
    errors.push("customerReply が不足しています");
  }
  if (typeof value?.judgementReason !== "string" || !value.judgementReason.trim()) {
    errors.push("judgementReason が不足しています");
  }
  if (!["high", "medium", "low"].includes(value?.confidence)) {
    errors.push("confidence が不正です");
  }
  if (typeof value?.needsHumanAttention !== "boolean") {
    errors.push("needsHumanAttention がbooleanではありません");
  }
  return { ok: errors.length === 0, errors };
}
