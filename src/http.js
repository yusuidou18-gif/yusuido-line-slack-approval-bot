export async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

export function sendText(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

export async function postJson(url, body, headers = {}, options = {}) {
  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...headers
      },
      body: JSON.stringify(body)
    },
    options.timeoutMs || 12_000
  );

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const detail =
      data?.message ||
      data?.error ||
      (Array.isArray(data?.details) && data.details.length
        ? JSON.stringify(data.details)
        : "") ||
      data?.raw ||
      response.statusText;
    throw new Error(`HTTP ${response.status} ${url}: ${detail}`);
  }

  return data;
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: options.signal || controller.signal
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`HTTP timeout after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
