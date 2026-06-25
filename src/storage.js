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
