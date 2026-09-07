import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const TOKEN = JSON.parse(
  readFileSync(homedir() + "/.config/configstore/firebase-tools.json"),
).tokens?.access_token;
if (!TOKEN) throw new Error("no firebase token");

const PROJECT = "enterprise-ai-demo";

export async function logList(filter, { pageSize = 1000, maxPages = 20 } = {}) {
  let pageToken = undefined;
  const out = [];
  for (let i = 0; i < maxPages; i++) {
    const body = {
      resourceNames: [`projects/${PROJECT}`],
      filter,
      orderBy: "timestamp desc",
      pageSize,
    };
    if (pageToken) body.pageToken = pageToken;
    const res = await fetch("https://logging.googleapis.com/v2/entries:list", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    const j = await res.json();
    if (j.entries) out.push(...j.entries);
    pageToken = j.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
export const DAY = 864e5;
export { iso };

// CLI usage: node logq.mjs '<filter>' [maxPages]
if (import.meta.url === `file://${process.argv[1]}`) {
  const filter = process.argv[2];
  const maxPages = Number(process.argv[3] || 5);
  const entries = await logList(filter, { maxPages });
  console.log(`# ${entries.length} entries`);
  for (const e of entries) {
    const p =
      e.textPayload ??
      (e.jsonPayload ? JSON.stringify(e.jsonPayload) : "") ??
      "";
    const h = e.httpRequest
      ? `${e.httpRequest.status} ${e.httpRequest.latency} ${e.httpRequest.requestUrl}`
      : "";
    console.log(
      [e.timestamp, e.severity, e.resource?.labels?.service_name, h, p.slice(0, 300)]
        .filter(Boolean)
        .join(" | "),
    );
  }
}
