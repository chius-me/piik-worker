import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";

const origin = "https://piik.chius.dev";
const headers = {
  "User-Agent": "Mozilla/5.0 (compatible; PiikDeployCheck/1.0)",
};

for (let attempt = 1; ; attempt++) {
  try {
    const health = await fetch(`${origin}/api/health`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(health.status, 200, "Public health check failed");
    assert.equal(
      (await health.json()).sfuConfigured,
      true,
      "SFU credentials are missing",
    );

    const home = await fetch(origin, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(home.status, 200, "Public homepage failed");
    assert.match(await home.text(), /<title>Piik/);
    console.log(`Deployment verified: ${origin}`);

    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `### Piik deployed\n\n- Site: ${origin}\n- Commit: \`${process.env.GITHUB_SHA}\`\n- Homepage and SFU configuration: verified\n`,
      );
    }
    break;
  } catch (error) {
    if (attempt >= 5) throw error;
    console.warn(
      `Deployment check ${attempt}/5 failed: ${error.message}. Retrying…`,
    );
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
