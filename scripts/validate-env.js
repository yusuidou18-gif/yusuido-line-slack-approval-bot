import { getConfig } from "../src/config.js";

const config = getConfig();
const checks = [
  required("PORT", Number.isFinite(config.port)),
  required("PUBLIC_BASE_URL", Boolean(config.publicBaseUrl)),
  required("COMPANY_PHONE", Boolean(config.companyPhone)),

  required("LINE_CHANNEL_SECRET", Boolean(config.line.channelSecret)),
  required("LINE_CHANNEL_ACCESS_TOKEN", Boolean(config.line.channelAccessToken)),

  required("SLACK_SIGNING_SECRET", Boolean(config.slack.signingSecret)),
  required("SLACK_BOT_TOKEN", Boolean(config.slack.botToken)),
  required("SLACK_CHANNEL_ID", Boolean(config.slack.channelId)),
  required("SLACK_PRESIDENT_USER_ID", Boolean(config.slack.presidentUserId)),
  required("SLACK_OFFICE_USER_ID", Boolean(config.slack.officeUserId)),
  required(
    "SLACK_STAFF_USER_IDS",
    config.slack.staffUserIds && typeof config.slack.staffUserIds === "object"
  ),

  required("GOOGLE_CLIENT_EMAIL", Boolean(config.google.clientEmail)),
  required("GOOGLE_PRIVATE_KEY", Boolean(config.google.privateKey)),
  required("GOOGLE_DRIVE_FOLDER_ID", Boolean(config.google.driveFolderId)),
  required("GOOGLE_CALENDAR_IDS", Array.isArray(config.google.calendarIds))
];

const missing = checks.filter((check) => !check.ok);

for (const check of checks) {
  console.log(`${check.ok ? "OK " : "NG "} ${check.name}`);
}

if (missing.length) {
  console.error("");
  console.error("Missing or invalid settings:");
  for (const check of missing) console.error(`- ${check.name}`);
  console.error("");
  console.error("Create .env from .env.example and fill these values.");
  process.exitCode = 1;
} else {
  console.log("");
  console.log("OK: environment looks ready.");
}

function required(name, ok) {
  return { name, ok };
}
