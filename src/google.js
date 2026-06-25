import crypto from "node:crypto";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

let cachedToken = null;

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function getAccessToken(config) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  if (!config.google.clientEmail || !config.google.privateKey) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: config.google.clientEmail,
    scope: `${DRIVE_SCOPE} ${CALENDAR_SCOPE}`,
    aud: GOOGLE_TOKEN_URL,
    exp: now + 3600,
    iat: now
  };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(claim)
  )}`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(unsigned)
    .sign(config.google.privateKey, "base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const assertion = `${unsigned}.${signature}`;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Google token error: ${data.error_description || data.error}`);
  }

  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000
  };
  return cachedToken.accessToken;
}

async function googleGet(config, url) {
  const token = await getAccessToken(config);
  if (!token) return null;

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` }
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Google API error: ${data.error?.message || response.statusText}`);
  }
  return data;
}

export async function findDriveCaseInfo(config, messageText, sourceUserId) {
  if (!config.google.driveFolderId) return null;

  const terms = extractSearchTerms(messageText);
  if (sourceUserId) terms.push(sourceUserId);
  if (!terms.length) return null;

  const queryText = terms.map((term) => `fullText contains '${escapeQuery(term)}'`).join(" or ");
  const folderFilter = `'${escapeQuery(config.google.driveFolderId)}' in parents`;
  const q = `(${queryText}) and ${folderFilter} and trashed = false`;
  const params = new URLSearchParams({
    q,
    fields: "files(id,name,mimeType,webViewLink,modifiedTime)",
    pageSize: "5",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true"
  });

  const data = await googleGet(
    config,
    `https://www.googleapis.com/drive/v3/files?${params}`
  );
  if (!data?.files?.length) return null;

  return {
    matchedFiles: data.files,
    note: "Google Drive内の候補案件ファイルを検出しました。詳細項目は担当者確認が必要です。"
  };
}

export async function findCalendarAvailability(config) {
  if (!config.google.calendarIds.length) return [];

  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const results = [];

  for (const calendarId of config.google.calendarIds) {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "10"
    });

    const encodedId = encodeURIComponent(calendarId);
    const data = await googleGet(
      config,
      `https://www.googleapis.com/calendar/v3/calendars/${encodedId}/events?${params}`
    );
    results.push({
      calendarId,
      events: data?.items || []
    });
  }

  return results;
}

function extractSearchTerms(text) {
  const terms = [];
  const ids = text.match(/[A-Z]{1,5}-?\d{3,}/gi) || [];
  terms.push(...ids);

  const nameMatch = text.match(/([一-龥ぁ-んァ-ン]{2,8})(様|さん|さま)/);
  if (nameMatch) terms.push(nameMatch[1]);

  return [...new Set(terms)].slice(0, 5);
}

function escapeQuery(value) {
  return String(value).replace(/'/g, "\\'");
}
