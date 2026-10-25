import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { gather } from "../../src/client/media";

class Peer extends EventTarget {
  iceGatheringState: RTCIceGatheringState = "gathering";
  connectionState: RTCPeerConnectionState = "new";
  localDescription = { type: "offer", sdp: "v=0\r\n" };

  candidate(kind: string) {
    this.localDescription.sdp += `a=candidate:1 1 udp 1 192.0.2.1 5000 typ ${kind}\r\n`;
  }

  get connection() {
    return this as unknown as RTCPeerConnection;
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

test.each(["host", "srflx", "relay"])(
  "uses gathered %s candidates when another route stalls",
  async (kind) => {
    const peer = new Peer();
    const pending = gather(peer.connection);
    peer.candidate(kind);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toBeUndefined();
    expect(peer.iceGatheringState).toBe("gathering");
  },
);

test("finishes immediately when gathering completes with candidates", async () => {
  const peer = new Peer();
  const pending = gather(peer.connection);
  peer.candidate("relay");
  peer.iceGatheringState = "complete";
  peer.dispatchEvent(new Event("icegatheringstatechange"));
  await expect(pending).resolves.toBeUndefined();
  // Handles callers that attach after the complete event as well.
  await expect(gather(peer.connection)).resolves.toBeUndefined();
});

test("rejects a timeout without candidates", async () => {
  const peer = new Peer();
  const rejected = expect(gather(peer.connection)).rejects.toMatchObject({
    key: "noCandidates",
  });
  await vi.advanceTimersByTimeAsync(10_000);
  await rejected;
});

test("rejects completed gathering without candidates", async () => {
  const peer = new Peer();
  peer.iceGatheringState = "complete";
  await expect(gather(peer.connection)).rejects.toMatchObject({
    key: "noCandidates",
  });
});

test("cancels gathering as soon as the connection is closed", async () => {
  const peer = new Peer();
  peer.candidate("relay");
  const pending = gather(peer.connection);
  peer.connectionState = "closed";
  peer.dispatchEvent(new Event("connectionstatechange"));
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});
