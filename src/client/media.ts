import type { Description } from "../shared/protocol";
import { UiError } from "./i18n";

export async function gather(peer: RTCPeerConnection): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // Some STUN/TURN routes can keep gathering long after other routes work.
    // Send the candidates already in localDescription when the budget expires.
    const timer = setTimeout(() => finish(), 10_000);
    function change() {
      if (peer.connectionState === "closed")
        finish(new DOMException("Connection closed", "AbortError"));
      else if (peer.iceGatheringState === "complete") finish();
    }
    function finish(error?: Error) {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", change);
      peer.removeEventListener("connectionstatechange", change);
      if (error) reject(error);
      else if (
        peer.localDescription?.sdp
          .split(/\r?\n/)
          .some((line) => line.startsWith("a=candidate:"))
      )
        resolve();
      else reject(new UiError("noCandidates"));
    }
    peer.addEventListener("icegatheringstatechange", change);
    peer.addEventListener("connectionstatechange", change);
    change();
  });
}
export async function connected(peer: RTCPeerConnection): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new UiError("mediaTimeout")), 15_000);
    function change() {
      if (peer.connectionState === "connected") finish();
      else if (
        peer.connectionState === "failed" ||
        peer.connectionState === "closed"
      )
        finish(new UiError("mediaRetry"));
    }
    function finish(error?: Error) {
      clearTimeout(timer);
      peer.removeEventListener("connectionstatechange", change);
      error ? reject(error) : resolve();
    }
    peer.addEventListener("connectionstatechange", change);
    change();
  });
}
export function description(peer: RTCPeerConnection): Description {
  const value = peer.localDescription;
  if (!value?.sdp || (value.type !== "offer" && value.type !== "answer"))
    throw new UiError("mediaRetry");
  return { type: value.type, sdp: value.sdp };
}
