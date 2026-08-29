import fs from "node:fs/promises";
import path from "node:path";
import { hashId } from "./audit.js";

const DATA_DIR = path.resolve("data");
const REQUESTS_PATH = path.join(DATA_DIR, "approval-requests.json");
const CONVERSATIONS_PATH = path.join(DATA_DIR, "conversations.json");
const PROFILES_PATH = path.join(DATA_DIR, "customer-profiles.json");
let poolPromise = null;

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function readRequests() {
  const pool = await getPool();
  if (pool) {
    await ensureDatabase(pool);
    const result = await pool.query("select id, payload from approval_requests order by created_at asc");
    return Object.fromEntries(result.rows.map((row) => [row.id, row.payload]));
  }

  await ensureDataDir();
  try {
    const raw = await fs.readFile(REQUESTS_PATH, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

export async function writeRequests(requests) {
  const pool = await getPool();
  if (pool) {
    await ensureDatabase(pool);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("delete from approval_requests");
      for (const [id, request] of Object.entries(requests || {})) {
        await upsertApprovalRequest(client, id, request);
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return;
  }

  await ensureDataDir();
  await fs.writeFile(REQUESTS_PATH, JSON.stringify(requests, null, 2));
}

async function readJson(pathname, fallback) {
  const pool = await getPool();
  if (pool) {
    await ensureDatabase(pool);
    const table = tableForPath(pathname);
    const result = await pool.query(`select id, payload from ${table}`);
    return Object.fromEntries(result.rows.map((row) => [row.id, row.payload]));
  }

  await ensureDataDir();
  try {
    const raw = await fs.readFile(pathname, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(pathname, value) {
  const pool = await getPool();
  if (pool) {
    await ensureDatabase(pool);
    const table = tableForPath(pathname);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`delete from ${table}`);
      for (const [id, payload] of Object.entries(value || {})) {
        await client.query(
          `insert into ${table} (id, payload, updated_at) values ($1, $2::jsonb, now())
           on conflict (id) do update set payload = excluded.payload, updated_at = now()`,
          [id, JSON.stringify(payload)]
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return;
  }

  await ensureDataDir();
  await fs.writeFile(pathname, JSON.stringify(value, null, 2));
}

export async function saveRequest(request) {
  const pool = await getPool();
  if (pool) {
    await ensureDatabase(pool);
    try {
      await upsertApprovalRequest(pool, request.id, request);
      return request;
    } catch (error) {
      if (error.code === "23505" && request.lineMessageId) {
        return await getRequestByLineMessageId(request.lineMessageId);
      }
      throw error;
    }
  }

  const requests = await readRequests();
  requests[request.id] = request;
  await writeRequests(requests);
  return request;
}

export async function getRequest(id) {
  const pool = await getPool();
  if (pool) {
    await ensureDatabase(pool);
    const result = await pool.query("select payload from approval_requests where id = $1", [id]);
    return result.rows[0]?.payload || null;
  }

  const requests = await readRequests();
  return requests[id] || null;
}

export async function getRequestByLineMessageId(lineMessageId) {
  if (!lineMessageId) return null;
  const pool = await getPool();
  if (pool) {
    await ensureDatabase(pool);
    const result = await pool.query("select payload from approval_requests where line_message_id = $1 limit 1", [lineMessageId]);
    return result.rows[0]?.payload || null;
  }

  const requests = await readRequests();
  return Object.values(requests).find((request) => request.lineMessageId === lineMessageId) || null;
}

export async function updateRequest(id, updater) {
  const pool = await getPool();
  if (pool) {
    await ensureDatabase(pool);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await client.query("select payload from approval_requests where id = $1 for update", [id]);
      const current = result.rows[0]?.payload;
      if (!current) {
        await client.query("rollback");
        return null;
      }
      const updated = updater(current);
      await upsertApprovalRequest(client, id, updated);
      await client.query("commit");
      return updated;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  const requests = await readRequests();
  if (!requests[id]) return null;
  requests[id] = updater(requests[id]);
  await writeRequests(requests);
  return requests[id];
}

export async function claimRequestForSending(id) {
  const pool = await getPool();
  if (pool) {
    await ensureDatabase(pool);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await client.query("select payload from approval_requests where id = $1 for update", [id]);
      const request = result.rows[0]?.payload;
      if (!request || request.status !== "approved_ready_to_send" || request.sentAt || request.sendStartedAt) {
        await client.query("rollback");
        return null;
      }
      const claimed = markSending(request);
      await upsertApprovalRequest(client, id, claimed);
      await client.query("commit");
      return claimed;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  const requests = await readRequests();
  const request = requests[id];
  if (!request) return null;
  if (request.status !== "approved_ready_to_send" || request.sentAt || request.sendStartedAt) {
    return null;
  }

  requests[id] = markSending(request);
  await writeRequests(requests);
  return requests[id];
}

export async function invalidatePendingRequestsForLineUser(lineUserId, reason) {
  if (!lineUserId) return 0;
  const requests = await readRequests();
  const now = new Date().toISOString();
  let count = 0;

  for (const request of Object.values(requests)) {
    if (request.lineUserId !== lineUserId) continue;
    if (!["pending", "revision_requested", "approved_ready_to_send"].includes(request.status)) {
      continue;
    }
    request.status = "stale";
    request.draft = {
      ...(request.draft || {}),
      status: "stale",
      staleReason: reason || "新しいLINEメッセージを受信"
    };
    request.history = [
      ...(request.history || []),
      {
        at: now,
        type: "draft_stale",
        note: reason || "新しいLINEメッセージを受信したため旧返信案を無効化"
      }
    ];
    count += 1;
  }

  if (count) await writeRequests(requests);
  return count;
}

export async function appendConversationMessage(lineUserId, message) {
  const conversations = await readJson(CONVERSATIONS_PATH, {});
  const conversationId = buildConversationId(lineUserId);
  const current = conversations[conversationId] || {
    id: conversationId,
    lineUserIdHash: hashId(lineUserId),
    messages: [],
    lastOfferedSlots: [],
    updatedAt: ""
  };
  current.messages = [...(current.messages || []), message].slice(-30);
  if (message.lineMessageId) {
    current.processedLineMessageIds = [
      ...new Set([...(current.processedLineMessageIds || []), message.lineMessageId])
    ].slice(-100);
  }
  current.updatedAt = message.at || new Date().toISOString();
  conversations[conversationId] = current;
  await writeJson(CONVERSATIONS_PATH, conversations);
  return current;
}

export async function getConversationByLineUser(lineUserId) {
  const conversations = await readJson(CONVERSATIONS_PATH, {});
  return conversations[buildConversationId(lineUserId)] || null;
}

export async function updateConversation(lineUserId, updater) {
  const conversations = await readJson(CONVERSATIONS_PATH, {});
  const conversationId = buildConversationId(lineUserId);
  const current = conversations[conversationId] || {
    id: conversationId,
    lineUserIdHash: hashId(lineUserId),
    messages: [],
    lastOfferedSlots: [],
    updatedAt: ""
  };
  conversations[conversationId] = updater(current);
  await writeJson(CONVERSATIONS_PATH, conversations);
  return conversations[conversationId];
}

export async function getCustomerProfileByLineUser(lineUserId) {
  const profiles = await readJson(PROFILES_PATH, {});
  return profiles[buildConversationId(lineUserId)] || null;
}

export async function upsertCustomerProfile(lineUserId, patch) {
  const profiles = await readJson(PROFILES_PATH, {});
  const profileId = buildConversationId(lineUserId);
  const current = profiles[profileId] || {
    id: profileId,
    lineUserIdHash: hashId(lineUserId),
    matchConfidence: "unknown",
    createdAt: new Date().toISOString()
  };
  profiles[profileId] = {
    ...current,
    ...patch,
    lineUserIdHash: hashId(lineUserId),
    updatedAt: new Date().toISOString()
  };
  await writeJson(PROFILES_PATH, profiles);
  return profiles[profileId];
}

function buildConversationId(lineUserId) {
  return `line_${hashId(lineUserId)}`;
}

async function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!poolPromise) {
    poolPromise = import("pg").then(({ Pool }) =>
      new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }
      })
    );
  }
  return poolPromise;
}

async function ensureDatabase(pool) {
  await pool.query(`
    create table if not exists approval_requests (
      id text primary key,
      line_message_id text,
      status text not null,
      payload jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
  await pool.query("create unique index if not exists approval_requests_line_message_id_idx on approval_requests(line_message_id) where line_message_id is not null and line_message_id <> ''");
  await pool.query(`
    create table if not exists conversations (
      id text primary key,
      payload jsonb not null,
      updated_at timestamptz not null default now()
    )
  `);
  await pool.query(`
    create table if not exists customer_profiles (
      id text primary key,
      payload jsonb not null,
      updated_at timestamptz not null default now()
    )
  `);
}

async function upsertApprovalRequest(clientOrPool, id, request) {
  await clientOrPool.query(
    `insert into approval_requests (id, line_message_id, status, payload, created_at, updated_at)
     values ($1, $2, $3, $4::jsonb, coalesce($5::timestamptz, now()), now())
     on conflict (id) do update set
       line_message_id = excluded.line_message_id,
       status = excluded.status,
       payload = excluded.payload,
       updated_at = now()`,
    [
      id,
      request.lineMessageId || null,
      request.status || "unknown",
      JSON.stringify(request),
      request.createdAt || null
    ]
  );
}

function tableForPath(pathname) {
  if (pathname === CONVERSATIONS_PATH) return "conversations";
  if (pathname === PROFILES_PATH) return "customer_profiles";
  throw new Error(`No database table mapping for ${pathname}`);
}

function markSending(request) {
  const now = new Date().toISOString();
  return {
    ...request,
    status: "sending",
    sendStartedAt: now,
    history: [
      ...(request.history || []),
      {
        at: now,
        type: "line_send_claimed",
        note: "LINE送信処理を確保"
      }
    ]
  };
}
