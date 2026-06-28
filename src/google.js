import crypto from "node:crypto";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const GOOGLE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";
const TEXT_MIMES = new Set(["text/plain", "text/csv"]);
const SITE_VISIT_STAFF_NAMES = ["下村", "下村奈生", "菅野", "菅野香織"];
const SITE_VISIT_SLOT_HOURS_JST = [10, 13, 15, 17];

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

async function googleGetText(config, url) {
  const token = await getAccessToken(config);
  if (!token) return "";

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Google API error: ${text || response.statusText}`);
  }
  return text;
}

export async function findDriveCaseInfo(config, messageText, sourceUserId) {
  if (!config.google.driveFolderId) return null;

  const terms = extractSearchTerms(messageText);
  if (sourceUserId) terms.push(sourceUserId);
  if (!terms.length) return null;

  const queryText = terms
    .map((term) => `fullText contains '${escapeQuery(term)}'`)
    .join(" or ");
  const folderIds = await listDriveFolderIds(config, config.google.driveFolderId);
  const folderFilter = folderIds
    .map((folderId) => `'${escapeQuery(folderId)}' in parents`)
    .join(" or ");
  const q = `(${queryText}) and (${folderFilter}) and trashed = false`;
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

  const matchedFiles = [];
  for (const file of data.files) {
    const bodyText = await readDriveFileText(config, file);
    matchedFiles.push({
      ...file,
      textPreview: bodyText.slice(0, 1000),
      extracted: extractCaseFields(`${file.name}\n${bodyText}`)
    });
  }

  const bestFile =
    matchedFiles.find((file) => hasUsefulCaseFields(file.extracted)) || matchedFiles[0];
  const caseFields = bestFile?.extracted || {};

  return {
    matchedFiles,
    case: caseFields,
    note: buildDriveNote(matchedFiles, caseFields)
  };
}

export async function findCalendarAvailability(config, caseInfo) {
  if (!config.google.calendarIds.length) return [];

  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const results = [];
  const calendars = normalizeCalendarConfigs(config.google.calendarIds, caseInfo?.case?.staffName);

  for (const calendar of calendars) {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "10"
    });

    const encodedId = encodeURIComponent(calendar.id);
    const data = await googleGet(
      config,
      `https://www.googleapis.com/calendar/v3/calendars/${encodedId}/events?${params}`
    );
    const events = data?.items || [];
    results.push({
      calendarId: calendar.id,
      name: calendar.name || calendar.id,
      staffName: calendar.staffName || "",
      events,
      availableSlots: buildAvailableSlots(events)
    });
  }

  return results;
}

async function readDriveFileText(config, file) {
  const encodedId = encodeURIComponent(file.id);
  if (file.mimeType === GOOGLE_DOC_MIME) {
    const params = new URLSearchParams({ mimeType: "text/plain" });
    return googleGetText(
      config,
      `https://www.googleapis.com/drive/v3/files/${encodedId}/export?${params}`
    );
  }

  if (file.mimeType === GOOGLE_SHEET_MIME) {
    const params = new URLSearchParams({ mimeType: "text/csv" });
    return googleGetText(
      config,
      `https://www.googleapis.com/drive/v3/files/${encodedId}/export?${params}`
    );
  }

  if (TEXT_MIMES.has(file.mimeType)) {
    return googleGetText(
      config,
      `https://www.googleapis.com/drive/v3/files/${encodedId}?alt=media`
    );
  }

  return "";
}

async function listDriveFolderIds(config, rootFolderId) {
  const seen = new Set([rootFolderId]);
  let currentLevel = [rootFolderId];

  for (let depth = 0; depth < 3 && currentLevel.length; depth += 1) {
    const nextLevel = [];
    for (const folderId of currentLevel) {
      const params = new URLSearchParams({
        q: `'${escapeQuery(folderId)}' in parents and mimeType = '${GOOGLE_FOLDER_MIME}' and trashed = false`,
        fields: "files(id,name)",
        pageSize: "100",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true"
      });
      const data = await googleGet(
        config,
        `https://www.googleapis.com/drive/v3/files?${params}`
      );
      for (const folder of data?.files || []) {
        if (!seen.has(folder.id)) {
          seen.add(folder.id);
          nextLevel.push(folder.id);
        }
      }
    }
    currentLevel = nextLevel;
  }

  return [...seen].slice(0, 50);
}

function extractSearchTerms(text) {
  const terms = [];
  const normalized = String(text || "");
  const ids = normalized.match(/[A-Z]{1,5}-?\d{3,}/gi) || [];
  const phones = normalized.match(/0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}/g) || [];
  const nameMatch = normalized.match(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]{2,12})(様|さん|さま)/u);

  terms.push(...ids);
  terms.push(...phones.map((phone) => phone.replace(/\D/g, "")));
  if (nameMatch) terms.push(nameMatch[1]);

  return [...new Set(terms)].slice(0, 5);
}

function escapeQuery(value) {
  return String(value).replace(/'/g, "\\'");
}

function extractCaseFields(text) {
  const fields = {
    customerName: pickField(text, ["顧客名", "お客様名", "氏名", "名前"]),
    caseId: pickField(text, ["案件ID", "案件番号", "管理番号", "ID"]),
    customerType: pickField(text, ["新規/OB", "顧客区分", "区分", "新規・OB"]),
    staffName: pickField(text, ["担当者", "営業担当", "担当", "現調担当"]),
    caseStatus: pickField(text, ["ステータス", "案件ステータス", "進捗", "状態"]),
    estimateStatus: pickField(text, ["見積提出済み", "見積", "見積状況"]),
    constructionSchedule: pickField(text, ["工事予定", "施工予定", "工事日", "施工日"]),
    complaintHistory: pickField(text, ["クレーム履歴", "トラブル履歴", "クレーム", "トラブル"]),
    phone: pickField(text, ["電話番号", "TEL", "携帯"]),
    address: pickField(text, ["住所", "現場住所", "施工住所"])
  };

  if (!fields.caseId) {
    const id = text.match(/[A-Z]{1,5}-?\d{3,}/i);
    if (id) fields.caseId = id[0];
  }
  if (!fields.phone) {
    const phone = text.match(/0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}/);
    if (phone) fields.phone = phone[0];
  }
  if (!fields.customerType && /(^|\s|,)(OB|リピーター|既存|再依頼)(\s|,|$)/i.test(text)) {
    fields.customerType = "OB";
  }

  return removeEmpty(fields);
}

function pickField(text, labels) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(`${escaped}\\s*[：:\\t,]\\s*([^\\n\\r,]{1,80})`, "i"));
    if (match) return cleanupValue(match[1]);
  }
  return "";
}

function cleanupValue(value) {
  return String(value || "")
    .replace(/^["'「]+|["'」]+$/g, "")
    .trim();
}

function removeEmpty(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value));
}

function hasUsefulCaseFields(fields) {
  return Boolean(fields.customerName || fields.caseId || fields.staffName || fields.caseStatus);
}

function buildDriveNote(files, fields) {
  const names = files.map((file) => file.name).join(", ");
  const picked = [
    fields.customerName && `顧客名:${fields.customerName}`,
    fields.caseId && `案件ID:${fields.caseId}`,
    fields.customerType && `区分:${fields.customerType}`,
    fields.staffName && `担当:${fields.staffName}`,
    fields.caseStatus && `状態:${fields.caseStatus}`,
    fields.estimateStatus && `見積:${fields.estimateStatus}`,
    fields.constructionSchedule && `工事予定:${fields.constructionSchedule}`,
    fields.complaintHistory && `クレーム履歴:${fields.complaintHistory}`
  ].filter(Boolean);

  return [
    `Google Driveで候補案件ファイルを${files.length}件検出: ${names}`,
    picked.length ? `抽出項目: ${picked.join(" / ")}` : "抽出項目は未確定のため担当者確認が必要"
  ].join("。");
}

function normalizeCalendarConfigs(calendarIds, staffName) {
  const normalized = calendarIds.map((calendar) =>
    typeof calendar === "string" ? { id: calendar } : calendar
  );
  const siteVisitCalendars = normalized.filter((calendar) => {
    const names = calendar.staffNames || [calendar.staffName, calendar.name].filter(Boolean);
    return names.some((name) => isSiteVisitStaffName(name));
  });
  const baseCalendars = siteVisitCalendars.length ? siteVisitCalendars : normalized;
  const filtered = staffName
    ? baseCalendars.filter((calendar) => {
        const names = calendar.staffNames || [calendar.staffName, calendar.name].filter(Boolean);
        return !names.length || names.includes(staffName) || names.some((name) => isSiteVisitStaffName(name));
      })
    : baseCalendars;

  return (filtered.length ? filtered : normalized).filter((calendar) => calendar.id);
}

function buildAvailableSlots(events) {
  const slots = [];
  const now = new Date();

  for (let dayOffset = 1; dayOffset <= 14 && slots.length < 6; dayOffset += 1) {
    const base = toJstParts(new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000));
    if (base.weekday === 0 || base.weekday === 1) continue;

    for (const hour of SITE_VISIT_SLOT_HOURS_JST) {
      const start = fromJstParts(base.year, base.month, base.day, hour, 0);
      const end = new Date(start.getTime() + 90 * 60 * 1000);
      if (!hasConflict(events, start, end)) {
        slots.push({ start: start.toISOString(), end: end.toISOString() });
        if (slots.length >= 6) break;
      }
    }
  }

  return slots;
}

function isSiteVisitStaffName(value) {
  const text = String(value || "").normalize("NFKC");
  return SITE_VISIT_STAFF_NAMES.some((name) => text.includes(name));
}

function toJstParts(date) {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short"
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || "";
  const weekdayText = value("weekday");
  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
    weekday: ["日", "月", "火", "水", "木", "金", "土"].indexOf(weekdayText)
  };
}

function fromJstParts(year, month, day, hour, minute) {
  return new Date(Date.UTC(year, month - 1, day, hour - 9, minute, 0, 0));
}

function hasConflict(events, slotStart, slotEnd) {
  return events.some((event) => {
    const startValue = event.start?.dateTime || event.start?.date;
    const endValue = event.end?.dateTime || event.end?.date;
    if (!startValue || !endValue) return false;
    const eventStart = new Date(startValue);
    const eventEnd = new Date(endValue);
    return eventStart < slotEnd && eventEnd > slotStart;
  });
}
