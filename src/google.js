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
  const sheetMatch = await findCaseInManagementSheet(config, messageText, sourceUserId, terms);
  if (sheetMatch) return sheetMatch;
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

async function findCaseInManagementSheet(config, messageText, sourceUserId, terms) {
  const sheetName = config.google.caseSheetName || "湧水堂_案件管理";
  const folderIds = await listDriveFolderIds(config, config.google.driveFolderId);
  const folderFilter = folderIds
    .map((folderId) => `'${escapeQuery(folderId)}' in parents`)
    .join(" or ");
  const q = `name = '${escapeQuery(sheetName)}' and (${folderFilter}) and trashed = false`;
  const params = new URLSearchParams({
    q,
    fields: "files(id,name,mimeType,webViewLink,modifiedTime)",
    pageSize: "3",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true"
  });
  const data = await googleGet(
    config,
    `https://www.googleapis.com/drive/v3/files?${params}`
  );
  const file = data?.files?.find((item) => item.mimeType === GOOGLE_SHEET_MIME) || data?.files?.[0];
  if (!file) return null;

  const csv = await readDriveFileText(config, file);
  const rows = parseCsv(csv);
  if (rows.length < 2) return null;
  const headers = rows[0].map(normalizeHeader);
  const records = rows.slice(1).map((row, index) => ({
    index: index + 2,
    raw: row,
    record: Object.fromEntries(headers.map((header, columnIndex) => [header, row[columnIndex] || ""]))
  }));
  const candidates = records
    .map((entry) => ({
      ...entry,
      score: scoreCaseRecord(entry.record, messageText, sourceUserId, terms)
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) return null;
  const best = candidates[0];
  const caseFields = extractCaseFieldsFromRecord(best.record);
  return {
    matchedFiles: [
      {
        ...file,
        sheetRow: best.index,
        textPreview: best.raw.join(" "),
        extracted: caseFields
      }
    ],
    case: caseFields,
    matchConfidence: best.score >= 5 ? "high" : best.score >= 3 ? "medium" : "low",
    note: buildDriveNote([{ ...file, name: `${file.name} ${best.index}行目` }], caseFields)
  };
}

export async function findCalendarAvailability(config, caseInfo, messageText = "") {
  if (!config.google.calendarIds.length) return [];

  const now = new Date();
  const preference = parseSchedulePreference(messageText, now);
  const timeMin = now.toISOString();
  const searchDays = preference.explicitDates.length ? 60 : 21;
  const timeMax = new Date(now.getTime() + searchDays * 24 * 60 * 60 * 1000).toISOString();
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
    const checkedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    results.push({
      calendarId: calendar.id,
      name: calendar.name || calendar.id,
      staffName: calendar.staffName || "",
      events,
      preference,
      checkedAt,
      expiresAt,
      availableSlots: buildAvailableSlots(events, preference).map((slot, index) => ({
        ...slot,
        slotId: buildSlotId(calendar, slot, index),
        calendarId: calendar.id,
        staffName: calendar.staffName || calendar.name || "",
        checkedAt,
        expiresAt
      }))
    });
  }

  return results;
}

export async function verifyCalendarSlotAvailable(config, slot) {
  if (!slot?.calendarId || !slot.start || !slot.end) return { ok: false, reason: "候補枠情報が不足しています" };

  const params = new URLSearchParams({
    timeMin: new Date(slot.start).toISOString(),
    timeMax: new Date(slot.end).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "10"
  });
  const encodedId = encodeURIComponent(slot.calendarId);
  const data = await googleGet(
    config,
    `https://www.googleapis.com/calendar/v3/calendars/${encodedId}/events?${params}`
  );
  const events = data?.items || [];
  const start = new Date(slot.start);
  const end = new Date(slot.end);
  return {
    ok: !hasConflict(events, start, end),
    reason: events.length ? "候補枠に予定が入っています" : "",
    events
  };
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

function extractCaseFieldsFromRecord(record) {
  return removeEmpty({
    customerName: pickRecordField(record, ["顧客名", "お客様名", "氏名", "名前"]),
    caseId: pickRecordField(record, ["案件ID", "案件番号", "管理番号", "ID"]),
    customerType: pickRecordField(record, ["新規/OB", "顧客区分", "区分", "新規・OB"]),
    staffName: pickRecordField(record, ["担当者", "営業担当", "担当", "現調担当"]),
    caseStatus: pickRecordField(record, ["ステータス", "案件ステータス", "進捗", "状態"]),
    estimateStatus: pickRecordField(record, ["見積提出済み", "見積", "見積状況"]),
    constructionSchedule: pickRecordField(record, ["工事予定", "施工予定", "工事日", "施工日"]),
    complaintHistory: pickRecordField(record, ["クレーム履歴", "トラブル履歴", "クレーム", "トラブル"]),
    phone: pickRecordField(record, ["電話番号", "TEL", "携帯"]),
    address: pickRecordField(record, ["住所", "現場住所", "施工住所"])
  });
}

function pickRecordField(record, labels) {
  for (const label of labels) {
    const value = record[normalizeHeader(label)];
    if (value) return cleanupValue(value);
  }
  return "";
}

function scoreCaseRecord(record, messageText, sourceUserId, terms) {
  const values = Object.values(record).map((value) => String(value || ""));
  const joined = values.join(" ");
  const normalizedMessage = String(messageText || "").normalize("NFKC");
  let score = 0;

  for (const term of terms || []) {
    if (term && joined.includes(term)) score += term === sourceUserId ? 5 : 2;
  }

  const phone = normalizedMessage.match(/0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}/)?.[0]?.replace(/\D/g, "");
  if (phone && joined.replace(/\D/g, "").includes(phone)) score += 4;

  const caseId = normalizedMessage.match(/[A-Z]{1,5}-?\d{3,}/i)?.[0];
  if (caseId && joined.toLowerCase().includes(caseId.toLowerCase())) score += 5;

  const nameMatch = normalizedMessage.match(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]{2,12})(様|さん|さま)/u);
  if (nameMatch && joined.includes(nameMatch[1])) score += 3;

  return score;
}

function normalizeHeader(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < String(csv || "").length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      field += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      row.push(field.trim());
      field = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(field.trim());
      if (row.some((value) => value)) rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += char;
  }

  row.push(field.trim());
  if (row.some((value) => value)) rows.push(row);
  return rows;
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

function buildAvailableSlots(events, preference = emptySchedulePreference(), now = new Date()) {
  const slots = [];
  const maxDays = preference.explicitDates.length ? 60 : 21;
  const slotHours = preference.hours.length ? preference.hours : SITE_VISIT_SLOT_HOURS_JST;

  for (let dayOffset = 1; dayOffset <= maxDays && slots.length < 6; dayOffset += 1) {
    const base = toJstParts(new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000));
    if (base.weekday === 0 || base.weekday === 1) continue;
    if (!matchesSchedulePreference(base, preference)) continue;

    for (const hour of slotHours) {
      const startMinutes = hour * 60;
      if (!matchesTimePreference(startMinutes, preference)) continue;
      const start = fromJstParts(base.year, base.month, base.day, hour, 0);
      const end = new Date(start.getTime() + 60 * 60 * 1000);
      if (!hasConflict(events, start, end)) {
        slots.push({
          start: start.toISOString(),
          end: end.toISOString(),
          slotMinutes: startMinutes
        });
        if (slots.length >= 6) break;
      }
    }
  }

  return slots;
}

function parseSchedulePreference(text, now = new Date()) {
  const normalized = normalizeScheduleText(text);
  const preference = emptySchedulePreference();

  const weekdayMap = [
    ["日", 0, /日曜|日曜日/],
    ["月", 1, /月曜|月曜日/],
    ["火", 2, /火曜|火曜日/],
    ["水", 3, /水曜|水曜日/],
    ["木", 4, /木曜|木曜日/],
    ["金", 5, /金曜|金曜日/],
    ["土", 6, /土曜|土曜日/]
  ];

  if (/土日|週末/.test(normalized)) {
    preference.weekdays.push(6, 0);
  }
  if (/平日/.test(normalized)) {
    preference.weekdays.push(2, 3, 4, 5);
  }
  for (const [, value, pattern] of weekdayMap) {
    if (pattern.test(normalized)) preference.weekdays.push(value);
  }

  const relativeWeek = normalized.includes("来週")
    ? "next"
    : normalized.includes("今週")
      ? "this"
      : "";

  const current = toJstParts(now);
  const datePattern = /(?:(\d{4})[年\/.-])?(\d{1,2})[月\/.-](\d{1,2})日?/g;
  for (const match of normalized.matchAll(datePattern)) {
    let year = match[1] ? Number(match[1]) : current.year;
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!isValidMonthDay(month, day)) continue;
    if (!match[1] && isPastJstDate(year, month, day, current)) year += 1;
    preference.explicitDates.push(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  }

  if (!preference.explicitDates.length) {
    const dayOnlyMatch = normalized.match(/(?:^|[^\d])(\d{1,2})日/);
    if (dayOnlyMatch) {
      const day = Number(dayOnlyMatch[1]);
      const target = resolveDayOnlyDate(day, preference.weekdays, now);
      if (target) preference.explicitDates.push(formatJstDateKey(target));
    }
  }

  if (!preference.explicitDates.length && relativeWeek && preference.weekdays.length === 1) {
    const target = resolveRelativeWeekday(preference.weekdays[0], relativeWeek, now);
    if (target) preference.explicitDates.push(formatJstDateKey(target));
  }

  if (/明日/.test(normalized)) {
    const target = toJstParts(new Date(now.getTime() + 24 * 60 * 60 * 1000));
    preference.explicitDates.push(formatJstDateKey(target));
  }
  if (/明後日|あさって/.test(normalized)) {
    const target = toJstParts(new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000));
    preference.explicitDates.push(formatJstDateKey(target));
  }

  const afterMatch = normalized.match(/(午前|午後)?\s*([01]?\d|2[0-3])(?:[:時]([0-5]\d))?\s*(半)?\s*分?\s*(?:以降|から|後|あと)/);
  if (afterMatch) {
    preference.availableAfterMinutes = parseClockMinutes(afterMatch[2], afterMatch[3], afterMatch[4], afterMatch[1]);
  }

  const beforeMatch = normalized.match(/(午前|午後)?\s*([01]?\d|2[0-3])(?:[:時]([0-5]\d))?\s*(半)?\s*分?\s*(?:まで|以前|前)/);
  if (beforeMatch) {
    preference.availableBeforeMinutes = parseClockMinutes(beforeMatch[2], beforeMatch[3], beforeMatch[4], beforeMatch[1]);
  }

  const exactMatch = normalized.match(/(午前|午後)?\s*([01]?\d|2[0-3])(?:[:時]([0-5]\d))?\s*(半)?\s*分?\s*(?:で|に|なら|希望|お願いします|大丈夫)/);
  if (exactMatch && !preference.availableAfterMinutes) {
    preference.exactMinutes = parseClockMinutes(exactMatch[2], exactMatch[3], exactMatch[4], exactMatch[1]);
  }

  if (/午前|朝|10時|10:00/.test(normalized)) preference.hours.push(10);
  if (/午後|昼|13時|13:00/.test(normalized)) preference.hours.push(13, 15, 17);
  if (/15時|15:00/.test(normalized)) preference.hours.push(15);
  if (/夕方|17時|17:00/.test(normalized)) preference.hours.push(17);
  const timePattern = /([01]?\d|2[0-3])(?::[0-5]\d|時)/g;
  for (const match of normalized.matchAll(timePattern)) {
    if (!preference.availableAfterMinutes && preference.exactMinutes == null) {
      preference.hours.push(...nearestSiteVisitSlotHours(Number(match[1])));
    }
  }

  preference.weekdays = [...new Set(preference.weekdays)];
  preference.explicitDates = [...new Set(preference.explicitDates)];
  preference.hours = [...new Set(preference.hours)].filter((hour) =>
    SITE_VISIT_SLOT_HOURS_JST.includes(hour)
  );

  return preference;
}

function normalizeScheduleText(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/(午前|午後)?\s*([01]?\d|2[0-3])時半/g, "$1$2:30")
    .replace(/(午前|午後)?\s*([01]?\d|2[0-3])時([0-5]\d)分/g, "$1$2:$3")
    .replace(/(午前|午後)?\s*([01]?\d|2[0-3])時/g, "$1$2:00");
}

function emptySchedulePreference() {
  return {
    weekdays: [],
    explicitDates: [],
    hours: [],
    availableAfterMinutes: null,
    availableBeforeMinutes: null,
    exactMinutes: null
  };
}

function matchesSchedulePreference(day, preference) {
  const hasExplicitDates = preference.explicitDates.length > 0;
  const hasWeekdays = preference.weekdays.length > 0;
  if (hasExplicitDates && !preference.explicitDates.includes(formatJstDateKey(day))) return false;
  if (!hasExplicitDates && hasWeekdays && !preference.weekdays.includes(day.weekday)) return false;
  return true;
}

function matchesTimePreference(startMinutes, preference) {
  if (preference.availableAfterMinutes != null && startMinutes < preference.availableAfterMinutes) {
    return false;
  }
  if (preference.availableBeforeMinutes != null && startMinutes + 60 > preference.availableBeforeMinutes) {
    return false;
  }
  if (preference.exactMinutes != null) {
    const nearest = nearestSiteVisitSlotHours(Math.floor(preference.exactMinutes / 60));
    return nearest.includes(startMinutes / 60);
  }
  return true;
}

function parseClockMinutes(hourText, minuteText, halfText, meridiem) {
  let hour = Number(hourText);
  if (meridiem === "午後" && hour < 12) hour += 12;
  if (meridiem === "午前" && hour === 12) hour = 0;
  const minute = halfText ? 30 : Number(minuteText || 0);
  return hour * 60 + minute;
}

function resolveRelativeWeekday(weekday, relativeWeek, now) {
  const current = toJstParts(now);
  const currentStart = fromJstParts(current.year, current.month, current.day, 0, 0);
  const daysSinceSunday = current.weekday;
  const thisSunday = new Date(currentStart.getTime() - daysSinceSunday * 24 * 60 * 60 * 1000);
  const base = relativeWeek === "next"
    ? new Date(thisSunday.getTime() + 7 * 24 * 60 * 60 * 1000)
    : thisSunday;
  return toJstParts(new Date(base.getTime() + weekday * 24 * 60 * 60 * 1000));
}

function resolveDayOnlyDate(day, weekdays, now) {
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const current = toJstParts(now);
  for (let offset = 0; offset <= 60; offset += 1) {
    const target = toJstParts(new Date(now.getTime() + offset * 24 * 60 * 60 * 1000));
    if (target.day !== day) continue;
    if (isPastJstDate(target.year, target.month, target.day, current)) continue;
    if (weekdays.length && !weekdays.includes(target.weekday)) continue;
    if (!isValidMonthDay(target.month, target.day)) continue;
    return target;
  }
  return null;
}

function formatJstDateKey(day) {
  return `${day.year}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
}

function isPastJstDate(year, month, day, current) {
  return (
    year < current.year ||
    (year === current.year && month < current.month) ||
    (year === current.year && month === current.month && day <= current.day)
  );
}

function isValidMonthDay(month, day) {
  if (!Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(2024, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function nearestSiteVisitSlotHours(hour) {
  const ranked = SITE_VISIT_SLOT_HOURS_JST
    .map((slotHour) => ({ slotHour, distance: Math.abs(slotHour - hour) }))
    .sort((a, b) => a.distance - b.distance || a.slotHour - b.slotHour);
  const nearestDistance = ranked[0]?.distance ?? 0;
  return ranked
    .filter((item) => item.distance === nearestDistance || item.distance <= 1)
    .map((item) => item.slotHour);
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

function buildSlotId(calendar, slot, index) {
  const raw = `${calendar.id || calendar.name}:${slot.start}:${index}`;
  return Buffer.from(raw).toString("base64url").slice(0, 32);
}

export const __googleTest = {
  buildAvailableSlots,
  emptySchedulePreference,
  parseSchedulePreference
};
