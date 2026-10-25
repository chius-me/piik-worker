import { reset } from "cloudflare:test";
import { beforeAll, afterAll, afterEach } from "vitest";
import { network } from "./sfu-mock";

beforeAll(async () => {
  network.configure({ onUnhandledFrame: "error" });
  await network.enable();
});
afterEach(async () => {
  network.resetHandlers();
  await reset();
});
afterAll(async () => {
  await network.disable();
});
