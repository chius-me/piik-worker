import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const publicRoot = ".cloudflare/output/v0/workers/default/assets";
const secrets = [];
try {
  const local = await readFile(".dev.vars", "utf8");
  for (const line of local.split("\n")) {
    const match =
      /^(?:REALTIME_SFU_BEARER_TOKEN|TURN_API_TOKEN)\s*=\s*(.+)$/.exec(line);
    if (!match) continue;
    let value = match[1].trim();
    try {
      value = JSON.parse(value);
    } catch {
      value = value.replace(/^['"]|['"]$/g, "");
    }
    if (typeof value === "string" && value.length > 8) secrets.push(value);
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await check(path);
      continue;
    }
    const text = await readFile(path, "utf8");
    if (
      /REALTIME_SFU_BEARER_TOKEN|TURN_API_TOKEN/.test(text) ||
      secrets.some((secret) => text.includes(secret))
    ) {
      throw new Error(
        "Server credentials or server-only bindings were found in browser assets.",
      );
    }
  }
}
await check(publicRoot);
console.log("Browser assets checked: no server credentials found.");
