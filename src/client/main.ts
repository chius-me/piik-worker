import { z } from "zod";
import {
  healthSchema,
  iceSchema,
  idSchema,
  joinedSchema,
  mediaSchema,
  snapshotSchema,
  ticketSchema,
  tokenSchema,
  type Snapshot,
} from "../shared/protocol";
import { ApiError, capability, request, type Credentials } from "./api";
import { connected, description, gather } from "./media";
import {
  apiErrorKey,
  currentLanguage,
  setLanguage,
  t,
  UiError,
  type TextKey,
} from "./i18n";

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const video = $<HTMLVideoElement>("video");
const nameInput = $<HTMLInputElement>("name");
const credentialSchema = z.object({
  roomId: idSchema,
  memberId: idSchema,
  memberToken: tokenSchema,
  name: z.string(),
  role: z.enum(["host", "viewer"]),
  inviteToken: tokenSchema.optional(),
});
let roomId = /^\/room\/([\da-f-]+)$/.exec(location.pathname)?.[1];
if (roomId && !idSchema.safeParse(roomId).success) roomId = undefined;
let credentials: Credentials | undefined = roomId
  ? readCredentials(roomId)
  : undefined;
let invite =
  new URLSearchParams(location.hash.slice(1)).get("invite") ??
  credentials?.inviteToken;
if (!tokenSchema.safeParse(invite).success) invite = undefined;
if (location.hash) history.replaceState(null, "", location.pathname);
if (roomId && invite) sessionStorage.setItem(`piik:invite:${roomId}`, invite);
invite ??= roomId
  ? (sessionStorage.getItem(`piik:invite:${roomId}`) ?? undefined)
  : undefined;
let snapshot: Snapshot | undefined;
let joined = false;
let busy = false;
let configured = false;
let life = 0;
let mediaEpoch = 0;
let source: MediaStream | undefined;
let peer: RTCPeerConnection | undefined;
let receivingShare: string | undefined;
let socket: WebSocket | undefined;
let polling: ReturnType<typeof setInterval> | undefined;
let socketTimer: ReturnType<typeof setTimeout> | undefined;
let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
let refreshPromise: Promise<void> | undefined;
let connecting = false;
let publishing = false;
let retries = 0;
let statusKey: TextKey | undefined;
let connectionKey: TextKey = "roomReady";

nameInput.value =
  credentials?.name ?? sessionStorage.getItem("piik:name") ?? "";
render();
void initialize();

async function initialize() {
  try {
    configured = (
      await request("/api/health", healthSchema, undefined, undefined, "GET")
    ).sfuConfigured;
  } catch {
    status("networkError", true);
  }
  render();
  if (credentials) {
    try {
      snapshot = await room("snapshot", snapshotSchema, undefined, "GET");
      const self = snapshot.members.find((m) => m.id === credentials!.memberId);
      if (!self)
        throw new ApiError("ACCESS_DENIED", "ACCESS_DENIED", false, 403);
      credentials.role = self.role;
      // A reload cannot silently reacquire screen permissions. Retire the old publisher.
      if (credentials.role === "host")
        snapshot = await room("stop", snapshotSchema);
      joined = true;
      persist();
      startBackground();
      render();
      if (credentials.role === "viewer") void receive();
    } catch (error) {
      handleError(error);
    }
  }
}

function readCredentials(id: string): Credentials | undefined {
  const raw = sessionStorage.getItem(`piik:member:${id}`);
  if (!raw) return;
  try {
    const result = credentialSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : undefined;
  } catch {
    return;
  }
}
function persist() {
  if (!credentials) return;
  sessionStorage.setItem(
    `piik:member:${credentials.roomId}`,
    JSON.stringify(credentials),
  );
  sessionStorage.setItem("piik:name", credentials.name);
}
function room<S extends z.ZodType>(
  action: string,
  schema: S,
  input?: unknown,
  method = "POST",
) {
  if (!credentials)
    throw new ApiError("ACCESS_DENIED", "ACCESS_DENIED", false, 403);
  return request(
    `/api/rooms/${credentials.roomId}/${action}`,
    schema,
    input,
    credentials,
    method,
  );
}
function renderStatus() {
  $("status").hidden = !statusKey;
  $("status-message").textContent = statusKey ? t(statusKey) : "";
  $("status")
    .querySelector("input")
    ?.setAttribute("aria-label", t("inviteLink"));
}
function status(key: TextKey | "", error = false) {
  statusKey = key || undefined;
  $("status").querySelector("input")?.remove();
  $("status").dataset.tone = error ? "error" : "neutral";
  renderStatus();
}
function connectionStatus(key: TextKey) {
  connectionKey = key;
  $("connection-text").textContent = t(key);
}
function handleError(error: unknown) {
  const key =
    error instanceof ApiError
      ? apiErrorKey(error.code)
      : error instanceof UiError
        ? error.key
        : error instanceof Error && error.name === "NotAllowedError"
          ? "shareCancelled"
          : error instanceof Error &&
              ["NotReadableError", "NotFoundError"].includes(error.name)
            ? "captureUnavailable"
            : "genericError";
  if (
    error instanceof ApiError &&
    (error.status === 403 || error.status === 410)
  ) {
    cleanupLocal();
    joined = false;
    if (credentials)
      sessionStorage.removeItem(`piik:member:${credentials.roomId}`);
    credentials = undefined;
    if (roomId) sessionStorage.removeItem(`piik:invite:${roomId}`);
    invite = undefined;
    render();
  }
  status(key, true);
}
async function action(fn: () => Promise<void>) {
  if (busy) return;
  busy = true;
  render();
  try {
    await fn();
  } catch (error) {
    handleError(error);
  } finally {
    busy = false;
    render();
  }
}

$("entry-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void action(async () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    const epoch = life;
    if (!roomId) {
      const pending = sessionStorage.getItem("piik:create");
      let candidate: Credentials;
      try {
        candidate = pending
          ? credentialSchema.parse(JSON.parse(pending))
          : freshHost(name);
      } catch {
        candidate = freshHost(name);
      }
      sessionStorage.setItem("piik:create", JSON.stringify(candidate));
      const result = await request("/api/rooms", joinedSchema, {
        roomId: candidate.roomId,
        memberId: candidate.memberId,
        memberToken: candidate.memberToken,
        inviteToken: candidate.inviteToken,
        name,
      });
      if (epoch !== life) return;
      credentials = candidate;
      roomId = candidate.roomId;
      invite = candidate.inviteToken;
      snapshot = result.snapshot;
      sessionStorage.removeItem("piik:create");
      history.replaceState(null, "", `/room/${roomId}`);
    } else {
      if (!invite) throw new UiError("inviteRequired");
      let candidate = credentials;
      if (!candidate) {
        const raw = sessionStorage.getItem(`piik:pending:${roomId}`);
        try {
          candidate = raw ? credentialSchema.parse(JSON.parse(raw)) : undefined;
        } catch {
          /* Discard malformed local state. */
        }
      }
      candidate ??= {
        roomId,
        memberId: crypto.randomUUID(),
        memberToken: capability(),
        name,
        role: "viewer",
      };
      sessionStorage.setItem(
        `piik:pending:${roomId}`,
        JSON.stringify(candidate),
      );
      const result = await request(`/api/rooms/${roomId}/join`, joinedSchema, {
        memberId: candidate.memberId,
        memberToken: candidate.memberToken,
        name,
        inviteToken: invite,
      });
      if (epoch !== life) return;
      credentials = { ...candidate, role: result.role };
      snapshot = result.snapshot;
      sessionStorage.removeItem(`piik:pending:${roomId}`);
    }
    joined = true;
    persist();
    startBackground();
    render();
    connectionStatus("roomReady");
    status("");
    if (credentials?.role === "viewer") void receive();
  });
});
function freshHost(name: string): Credentials {
  return {
    roomId: crypto.randomUUID(),
    memberId: crypto.randomUUID(),
    memberToken: capability(),
    name,
    role: "host",
    inviteToken: capability(),
  };
}

$("copy-invite").addEventListener("click", () => {
  void action(async () => {
    if (!credentials || credentials.role !== "host") return;
    // A host tab retains the current raw invite locally; the server stores its hash.
    if (!credentials.inviteToken) {
      credentials.inviteToken = capability();
      persist();
    }
    snapshot = await room("invite", snapshotSchema, {
      inviteToken: credentials.inviteToken,
    });
    const url = `${location.origin}/room/${credentials.roomId}#invite=${credentials.inviteToken}`;
    try {
      await navigator.clipboard.writeText(url);
      status("copied");
    } catch {
      status("copyManually");
      const field = document.createElement("input");
      field.className = "invite-fallback";
      field.value = url;
      field.readOnly = true;
      field.setAttribute("aria-label", t("inviteLink"));
      $("status").append(field);
      field.focus();
      field.select();
    }
  });
});

$("share").addEventListener("click", () => {
  void action(async () => {
    const epoch = life;
    if (!navigator.mediaDevices?.getDisplayMedia)
      throw new UiError("unsupported");
    const acquired = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30, max: 60 },
      },
      audio: true,
    });
    if (life !== epoch || !joined) {
      acquired.getTracks().forEach((t) => t.stop());
      return;
    }
    stopSource();
    source = acquired;
    for (const track of source.getVideoTracks()) {
      track.contentHint = "motion";
      track.addEventListener("ended", () => {
        if (source === acquired && joined)
          void stopSharing().catch(handleError);
      });
    }
    for (const track of source.getAudioTracks()) track.contentHint = "music";
    attach(source, true);
    render();
    try {
      await publish();
    } catch (error) {
      handleError(error);
      if (!(error instanceof ApiError) || error.retryable) scheduleRecovery();
    }
  });
});
$("stop").addEventListener("click", () => {
  void action(stopSharing);
});
async function stopSharing() {
  closeMedia();
  stopSource();
  attach(undefined);
  render();
  snapshot = await room("stop", snapshotSchema);
  status(snapshot.cleanupPending ? "stopPending" : "stopped");
}
$("reconnect").addEventListener("click", () => {
  void action(async () => {
    retries = 0;
    await refresh();
    if (!joined) return;
    if (credentials?.role === "host" && source) await publish();
    else if (credentials?.role === "viewer") await receive(true);
    else {
      connectionStatus("roomReady");
      status("");
    }
  });
});
$("leave").addEventListener("click", () => {
  void action(async () => {
    const ending = credentials?.role === "host";
    closeMedia();
    stopSource();
    const result = await room(ending ? "end" : "leave", snapshotSchema);
    cleanupLocal();
    joined = false;
    if (credentials)
      sessionStorage.removeItem(`piik:member:${credentials.roomId}`);
    if (!ending) {
      if (roomId) sessionStorage.removeItem(`piik:invite:${roomId}`);
      invite = undefined;
    }
    credentials = undefined;
    render();
    status(result.cleanupPending ? "leavePending" : ending ? "ended" : "left");
  });
});
$("members").addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>(
    "button[data-member]",
  );
  if (!button) return;
  void action(async () => {
    if (!credentials) return;
    const nextInvite = capability();
    credentials.inviteToken = nextInvite;
    persist();
    snapshot = await room("kick", snapshotSchema, {
      memberId: button.dataset.member,
      inviteToken: nextInvite,
    });
    status(snapshot.cleanupPending ? "removePending" : "removed");
  });
});
$("play").addEventListener("click", () => {
  video.muted = false;
  void playVideo();
});
video.addEventListener("loadedmetadata", () => {
  void playVideo();
});
video.addEventListener("playing", () => {
  if (joined && credentials?.role === "viewer") connectionStatus("watching");
});

function attach(stream?: MediaStream, local = false) {
  if (video.srcObject !== (stream ?? null)) video.srcObject = stream ?? null;
  video.muted = local;
  video.controls = !local;
  video.hidden = !stream;
  $("waiting").hidden = Boolean(stream);
  $("video-label").hidden = !stream || !local;
  $("play").hidden = true;
  if (stream) void playVideo();
}
async function playVideo() {
  if (!video.srcObject) return;
  try {
    await video.play();
    $("play").hidden = true;
  } catch {
    if (joined && credentials?.role === "viewer") $("play").hidden = false;
  }
}
function closeMedia() {
  mediaEpoch += 1;
  peer?.close();
  peer = undefined;
  receivingShare = undefined;
  clearTimeout(disconnectTimer);
  clearTimeout(recoveryTimer);
  disconnectTimer = undefined;
  recoveryTimer = undefined;
}
function stopSource() {
  const old = source;
  source = undefined;
  old?.getTracks().forEach((t) => t.stop());
}
async function newPeer(epoch: number): Promise<RTCPeerConnection> {
  const ice = await room("ice", iceSchema);
  if (epoch !== mediaEpoch || !joined)
    throw new DOMException("Connection replaced", "AbortError");
  const connection = new RTCPeerConnection(ice);
  peer = connection;
  connection.addEventListener("connectionstatechange", () => {
    if (connection !== peer) return;
    if (connection.connectionState === "failed") scheduleRecovery();
    else if (connection.connectionState === "disconnected") {
      clearTimeout(disconnectTimer);
      disconnectTimer = setTimeout(() => {
        if (
          connection === peer &&
          connection.connectionState === "disconnected"
        )
          scheduleRecovery();
      }, 5000);
      connectionStatus("unstable");
    } else if (connection.connectionState === "connected") {
      clearTimeout(disconnectTimer);
      disconnectTimer = undefined;
      retries = 0;
      connectionStatus(
        credentials?.role === "host"
          ? "sharing"
          : video.readyState >= 2
            ? "watching"
            : "receiving",
      );
    }
  });
  return connection;
}
async function publish(): Promise<void> {
  if (!source || !joined || publishing) return;
  publishing = true;
  closeMedia();
  const epoch = mediaEpoch;
  const captured = source;
  const attemptId = crypto.randomUUID();
  connectionStatus("connectingShare");
  try {
    const connection = await newPeer(epoch);
    const transceivers = captured
      .getTracks()
      .filter((t) => t.readyState === "live")
      .map((track) =>
        connection.addTransceiver(track, { direction: "sendonly" }),
      );
    await connection.setLocalDescription(await connection.createOffer());
    await gather(connection);
    if (epoch !== mediaEpoch) return;
    const reply = await room("publish", mediaSchema, {
      attemptId,
      description: description(connection),
      tracks: transceivers.map((t) => ({
        mid: t.mid,
        kind: t.sender.track!.kind,
      })),
    });
    if (epoch !== mediaEpoch) return;
    await connection.setRemoteDescription(reply.description);
    await connected(connection);
    if (epoch !== mediaEpoch) return;
    snapshot = await room("ready", snapshotSchema, { attemptId });
    if (epoch !== mediaEpoch) return;
    render();
    status("");
  } catch (error) {
    if (epoch !== mediaEpoch) return;
    peer?.close();
    peer = undefined;
    throw error;
  } finally {
    publishing = false;
  }
}
async function receive(force = false): Promise<void> {
  if (!joined || credentials?.role !== "viewer") return;
  const shareId = snapshot?.share?.id;
  if (!shareId) {
    closeMedia();
    attach(undefined);
    render();
    return;
  }
  if (connecting) return;
  if (!force && receivingShare === shareId && peer) return;
  connecting = true;
  closeMedia();
  const epoch = mediaEpoch;
  const attemptId = crypto.randomUUID();
  try {
    const connection = await newPeer(epoch);
    const incoming = new MediaStream();
    receivingShare = shareId;
    connection.addEventListener("track", (event) => {
      if (epoch === mediaEpoch) {
        incoming.addTrack(event.track);
        attach(incoming);
      }
    });
    connectionStatus("receiving");
    const reply = await room("subscribe", mediaSchema, { attemptId, shareId });
    if (epoch !== mediaEpoch) return;
    await connection.setRemoteDescription(reply.description);
    await connection.setLocalDescription(await connection.createAnswer());
    await gather(connection);
    if (epoch !== mediaEpoch) return;
    await room("answer", snapshotSchema, {
      attemptId,
      description: description(connection),
    });
    await connected(connection);
    if (epoch !== mediaEpoch) return;
    await room("ready", snapshotSchema, { attemptId });
    render();
    status("");
    connectionStatus(video.readyState >= 2 ? "watching" : "receiving");
  } catch (error) {
    if (epoch !== mediaEpoch) return;
    closeMedia();
    handleError(error);
    if (!(error instanceof ApiError) || error.retryable) scheduleRecovery();
  } finally {
    connecting = false;
    if (
      joined &&
      credentials?.role === "viewer" &&
      snapshot?.share?.id &&
      (!peer || receivingShare !== snapshot.share.id)
    )
      scheduleRecovery();
  }
}
function scheduleRecovery() {
  if (!joined || recoveryTimer || !navigator.onLine) return;
  connectionStatus("reconnecting");
  recoveryTimer = setTimeout(
    () => {
      recoveryTimer = undefined;
      void (async () => {
        const epoch = life;
        try {
          await refresh();
          if (!joined || epoch !== life) return;
          if (credentials?.role === "host" && source) await publish();
          else if (credentials?.role === "viewer")
            await receive(peer?.connectionState !== "connected");
        } catch (error) {
          if (epoch === life) {
            handleError(error);
            if (!(error instanceof ApiError) || error.retryable)
              scheduleRecovery();
          }
        }
      })();
    },
    Math.min(15_000, 1000 * 2 ** Math.min(retries++, 4)),
  );
}
async function refresh(): Promise<void> {
  if (refreshPromise) return refreshPromise;
  if (!joined) return;
  const epoch = life;
  refreshPromise = (async () => {
    try {
      const current = await room("snapshot", snapshotSchema, undefined, "GET");
      if (epoch !== life || !joined) return;
      snapshot = current;
      render();
      if (credentials?.role === "viewer") void receive();
    } catch (error) {
      if (epoch === life) handleError(error);
    }
  })().finally(() => {
    refreshPromise = undefined;
  });
  return refreshPromise;
}
function startBackground() {
  clearInterval(polling);
  polling = setInterval(() => {
    void refresh();
  }, 15_000);
  void connectSocket();
}
async function connectSocket() {
  if (!joined) return;
  const epoch = life;
  try {
    const { ticket } = await room("ticket", ticketSchema);
    if (epoch !== life || !joined) return;
    const url = new URL(
      `/api/rooms/${credentials!.roomId}/socket`,
      location.origin,
    );
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const next = new WebSocket(url, ["piik.v1", `ticket.${ticket}`]);
    socket?.close();
    socket = next;
    next.addEventListener("open", () => {
      void refresh();
    });
    next.addEventListener("message", (event) => {
      try {
        if (JSON.parse(event.data).type === "changed") void refresh();
      } catch {
        /* A later poll repairs a missed notification. */
      }
    });
    next.addEventListener("close", (event) => {
      if (event.code !== 4001 && socket === next && joined && epoch === life) {
        void refresh();
        socketTimer = setTimeout(() => {
          void connectSocket();
        }, 3000);
      }
    });
  } catch (error) {
    if (epoch === life && joined) {
      handleError(error);
      if (joined)
        socketTimer = setTimeout(() => {
          void connectSocket();
        }, 5000);
    }
  }
}
function cleanupLocal() {
  life += 1;
  closeMedia();
  stopSource();
  attach(undefined);
  clearInterval(polling);
  clearTimeout(socketTimer);
  socket?.close();
  socket = undefined;
}
window.addEventListener("online", () => {
  void refresh();
  scheduleRecovery();
});
window.addEventListener("offline", () => {
  if (joined) connectionStatus("offline");
});
window.addEventListener("pageshow", () => {
  if (joined) {
    void refresh();
    scheduleRecovery();
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && joined) {
    void refresh();
    if (
      !peer ||
      ["failed", "disconnected", "closed"].includes(peer.connectionState)
    )
      scheduleRecovery();
  }
});

$("language").addEventListener("click", () => {
  setLanguage(currentLanguage() === "zh" ? "en" : "zh");
  render();
});

function translatePage() {
  document.documentElement.lang = currentLanguage() === "zh" ? "zh-CN" : "en";
  document.title = t("title");
  document
    .querySelector('meta[name="description"]')
    ?.setAttribute("content", t("description"));
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n as TextKey);
  });
  document
    .querySelectorAll<HTMLElement>("[data-i18n-label]")
    .forEach((element) => {
      element.setAttribute(
        "aria-label",
        t(element.dataset.i18nLabel as TextKey),
      );
    });
  nameInput.placeholder = t("namePlaceholder");
  $("language-label").textContent = currentLanguage() === "zh" ? "中文" : "EN";
  $("language").setAttribute("aria-label", t("switchLanguage"));
  $("language").title = t("switchLanguage");
  renderStatus();
  connectionStatus(connectionKey);
}
function render() {
  translatePage();
  $("lobby").hidden = joined;
  $("room").hidden = !joined;
  $("configuration").hidden = configured;
  $("entry-title").textContent = t(roomId ? "joinTitle" : "createTitle");
  $("enter").textContent = t(busy ? "connecting" : roomId ? "join" : "create");
  $<HTMLButtonElement>("enter").disabled = busy || Boolean(roomId && !invite);
  $("entry-note").textContent = t(
    roomId ? (invite ? "joinNote" : "inviteRequired") : "createNote",
  );
  if (!joined || !credentials || !snapshot) return;
  const host = credentials.role === "host";
  $("copy-invite").hidden = !host;
  $("share").hidden = !host || Boolean(source);
  $("stop").hidden = !host || !source;
  $("leave").textContent = t(host ? "end" : "leave");
  $("role-label").textContent = t(host ? "host" : "viewer");
  $("waiting-title").textContent = t(
    host ? "waitingHost" : snapshot.share ? "receiving" : "waitingViewer",
  );
  $("waiting-description").textContent = t(host ? "chooseSource" : "stayHere");
  $("audio-note").textContent = t(
    host
      ? source
        ? source.getAudioTracks().length
          ? "sourceAudio"
          : "noSourceAudio"
        : "audioHint"
      : snapshot.share?.kinds.includes("audio")
        ? "playerHint"
        : "silentShare",
  );
  $("count").textContent =
    `${snapshot.members.filter((m) => m.role === "viewer").length} / 20`;
  // Keep the video element and stream stable while refreshing the roster.
  $("members").replaceChildren(
    ...snapshot.members.map((member) => {
      const row = document.createElement("li");
      row.className = "member";
      const avatar = document.createElement("span");
      avatar.className = "avatar";
      avatar.textContent = (Array.from(member.name)[0] ?? "").toUpperCase();
      avatar.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "member-name";
      label.textContent = member.name;
      label.title = member.name;
      const tag = document.createElement("span");
      tag.className = "member-tag";
      tag.textContent = t(
        member.role === "host"
          ? "host"
          : member.id === credentials!.memberId
            ? "you"
            : member.online
              ? "online"
              : "memberReconnecting",
      );
      row.append(avatar, label, tag);
      if (host && member.role === "viewer") {
        const kick = document.createElement("button");
        kick.className = "text-button kick";
        kick.dataset.member = member.id;
        kick.textContent = t("remove");
        kick.setAttribute("aria-label", `${t("remove")} ${member.name}`);
        row.append(kick);
      }
      return row;
    }),
  );
  for (const id of ["copy-invite", "share", "stop", "reconnect", "leave"])
    $<HTMLButtonElement>(id).disabled = busy || (id === "share" && !configured);
  if (host && source && peer?.connectionState === "connected")
    connectionStatus("sharing");
}
