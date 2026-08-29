import fs from "node:fs";

export function loadEnvFile(path = ".env") {
  if (!fs.existsSync(path)) return;

  const lines = fs.readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const index = trimmed.indexOf("=");
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) process.env[key] = value;
  }
}

function optionalJson(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
}

export function getConfig() {
  loadEnvFile();

  return {
    port: parsePort(process.env.PORT),
    publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
    companyPhone: process.env.COMPANY_PHONE || "",
    businessHoursText: process.env.BUSINESS_HOURS_TEXT || "",

    line: {
      channelSecret: process.env.LINE_CHANNEL_SECRET || "",
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || ""
    },

    slack: {
      signingSecret: process.env.SLACK_SIGNING_SECRET || "",
      botToken: process.env.SLACK_BOT_TOKEN || "",
      channelId: process.env.SLACK_CHANNEL_ID || "",
      presidentUserId: process.env.SLACK_PRESIDENT_USER_ID || "",
      officeUserId: process.env.SLACK_OFFICE_USER_ID || "",
      officeUserIds: optionalJson("SLACK_OFFICE_USER_IDS", []).filter(Boolean),
      staffUserIds: optionalJson("SLACK_STAFF_USER_IDS", {})
    },

    google: {
      clientEmail: process.env.GOOGLE_CLIENT_EMAIL || "",
      privateKey: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
      driveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID || "",
      caseSheetName: process.env.GOOGLE_CASE_SHEET_NAME || "湧水堂_案件管理",
      calendarIds: optionalJson("GOOGLE_CALENDAR_IDS", [])
    },

    llm: {
      apiKey: process.env.OPENAI_API_KEY || "",
      model: process.env.OPENAI_MODEL || "gpt-5.4-mini",
      required: process.env.REQUIRE_LLM === "true"
    }
  };
}

function parsePort(value) {
  const parsed = Number(value || 3000);
  if (Number.isInteger(parsed) && parsed >= 0 && parsed < 65536) return parsed;
  return process.env.RENDER ? 10000 : 3000;
}
