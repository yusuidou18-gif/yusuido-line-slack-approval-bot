import fs from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.resolve("data");
const REQUESTS_PATH = path.join(DATA_DIR, "approval-requests.json");

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function readRequests() {
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
  await ensureDataDir();
  await fs.writeFile(REQUESTS_PATH, JSON.stringify(requests, null, 2));
}

export async function saveRequest(request) {
  const requests = await readRequests();
  requests[request.id] = request;
  await writeRequests(requests);
  return request;
}

export async function getRequest(id) {
  const requests = await readRequests();
  return requests[id] || null;
}

export async function updateRequest(id, updater) {
  const requests = await readRequests();
  if (!requests[id]) return null;
  requests[id] = updater(requests[id]);
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
