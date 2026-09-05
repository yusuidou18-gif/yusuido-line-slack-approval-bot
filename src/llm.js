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
    "返信案は、相手の文章に出ている具体的な用件（例: トイレ交換、水漏れ、見積り、日程変更、工事後不具合）を必ず拾ってください。",
    "単に「担当者が確認します」「あらためてご連絡します」だけで終わる一般文にしないでください。",
    "金額、工期、値引き、対応可否、工事日、職人手配を確約しないでください。",
    "不明点は確認いたしますと表現してください。",
    "現地調査の日程候補がcontext内にある場合は、その候補だけを使い、1時間幅の箇条書きで提示してください。候補日や時刻を作らないでください。",
    "顧客が曜日・日付・時間帯を希望している場合は、その希望を受け止めた一文を入れてください。",
    "日曜・月曜の希望など定休日に関わる場合は、定休日であることをやわらかく伝え、火曜から土曜の営業時間内で調整する文にしてください。",
    "水漏れ、漏電、使用不能、強い不満など緊急性がある場合は、お電話（047-401-0700）での連絡も促してください。",
    "クレームや工事後不具合では、言い訳をせず先にお詫びし、事実確認後に対応方針を案内する文にしてください。",
    "見積り・費用・値引き・返金では、金額や値引き可否を約束せず、内容確認後に案内する文にしてください。",
    "写真があると判断しやすい用件では、気になる箇所のお写真を依頼してください。ただし日程調整だけの返信で不要に写真を求めないでください。",
    "LINEで読みやすい短い日本語にしてください。",
    "スタッフ名、Google、Slack、案件ID、判断理由、社長確認、承認などの社内情報を顧客本文に入れないでください。",
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
