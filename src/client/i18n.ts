export type Language = "zh" | "en";

export const messages = {
  title: ["Piik · 一起看", "Piik · Watch together"],
  description: [
    "屏幕与声音，分享给朋友。",
    "Share your screen and sound with friends.",
  ],
  home: ["Piik 首页", "Piik home"],
  switchLanguage: ["切换为英文", "Switch to Chinese"],
  privacy: ["仅限邀请", "Invite only"],
  headline: ["好东西，\n一起看。", "Good things.\nBetter together."],
  intro: ["屏幕与声音，分享给朋友。", "Share your screen and sound."],
  noInstall: ["无需安装", "No downloads"],
  capacity: ["最多 20 位朋友", "Up to 20 friends"],
  createTitle: ["留个座位。", "Take a seat."],
  joinTitle: ["朋友在等你。", "Join your friends."],
  name: ["你的名字", "Your name"],
  namePlaceholder: ["怎么称呼你？", "What should we call you?"],
  create: ["创建房间 ↗", "Create a room ↗"],
  join: ["加入房间 ↗", "Join room ↗"],
  connecting: ["连接中…", "Connecting…"],
  createNote: [
    "建房后，复制邀请给朋友。",
    "Create a room, then invite friends.",
  ],
  joinNote: ["加入即可观看。", "Join and watch."],
  inviteRequired: ["请向房主索取邀请。", "Ask the host for an invite."],
  roomTitle: ["一起看。", "Watch together."],
  copyInvite: ["复制邀请 ↗", "Copy invite ↗"],
  inviteLink: ["邀请链接", "Invite link"],
  host: ["房主", "Host"],
  viewer: ["观众", "Guest"],
  waitingHost: ["准备好就开始。", "Ready when you are."],
  waitingViewer: ["等待房主共享。", "Waiting for the host."],
  chooseSource: ["选择屏幕、窗口或标签页。", "Choose a screen, window or tab."],
  stayHere: ["画面开始后会自动播放。", "Playback starts when the host shares."],
  play: ["播放声音", "Play with sound"],
  preview: ["本地预览 · 静音", "Preview · Muted"],
  share: ["共享屏幕", "Share screen"],
  stop: ["停止共享", "Stop sharing"],
  reconnect: ["重新连接", "Reconnect"],
  friends: ["朋友", "Friends"],
  privateRoom: ["私密房间", "Private room"],
  leave: ["离开房间", "Leave room"],
  end: ["结束房间", "End room"],
  footer: ["一起看，更有趣。", "Better together."],
  unavailable: [
    "服务暂不可用，请稍后再试。",
    "Service unavailable. Try again soon.",
  ],
  roomReady: ["已连接", "Connected"],
  watching: ["正在观看", "Watching"],
  sharing: ["正在共享", "Sharing"],
  receiving: ["加载画面…", "Loading stream…"],
  connectingShare: ["连接共享…", "Connecting stream…"],
  reconnecting: ["重新连接中…", "Reconnecting…"],
  unstable: ["网络波动…", "Connection interrupted…"],
  offline: ["已离线，联网后自动重连", "Offline. Reconnecting when online."],
  sourceAudio: [
    "来源声音已共享 · 本地静音",
    "Source audio shared · Preview muted",
  ],
  noSourceAudio: [
    "此来源无声。共享标签页时勾选音频。",
    "No source audio. Enable audio when sharing a tab.",
  ],
  audioHint: [
    "共享标签页时，记得勾选音频。",
    "Enable audio when sharing a tab.",
  ],
  playerHint: [
    "在播放器中调节声音或全屏。",
    "Use the player for sound and full screen.",
  ],
  silentShare: ["当前共享无声。", "No audio in this share."],
  you: ["你", "You"],
  online: ["在线", "Online"],
  memberReconnecting: ["重连中", "Reconnecting"],
  remove: ["移出", "Remove"],
  copied: ["邀请已复制。", "Invite copied."],
  copyManually: ["请复制下方链接。", "Copy the link below."],
  stopped: ["共享已停止。", "Sharing stopped."],
  stopPending: [
    "共享已停止，正在清理连接。",
    "Sharing stopped. Closing connections…",
  ],
  left: ["已离开房间。", "You left the room."],
  ended: ["房间已结束。", "Room ended."],
  leavePending: ["已离开，正在清理连接。", "You left. Closing connections…"],
  removed: [
    "已移出。再次邀请请复制新链接。",
    "Guest removed. Copy a new link to invite others.",
  ],
  removePending: [
    "已移出，正在关闭连接。请复制新邀请。",
    "Guest removed. Closing connections. Copy a new invite.",
  ],
  genericError: ["操作未完成，请重试。", "Something went wrong. Try again."],
  networkError: [
    "连接中断，请检查网络。",
    "Connection lost. Check your network.",
  ],
  responseError: ["服务响应异常，请重试。", "Unexpected response. Try again."],
  accessDenied: [
    "加入已失效，请重新打开邀请。",
    "Access expired. Open your invite again.",
  ],
  inviteInvalid: [
    "邀请已失效，请索取新链接。",
    "Invite expired. Ask for a new link.",
  ],
  roomNotFound: ["房间不存在。", "Room not found."],
  roomFull: [
    "房间已满，最多 20 位观众。",
    "Room full. Up to 20 guests allowed.",
  ],
  roomLimit: [
    "加入次数已达上限，请新建房间。",
    "Join limit reached. Create a new room.",
  ],
  kicked: ["你已被房主移出。", "The host removed you."],
  hostOnly: ["仅房主可操作。", "Only the host can do this."],
  viewerOnly: ["仅观众可操作。", "Only guests can do this."],
  invalidRequest: [
    "请求无效，请刷新重试。",
    "Invalid request. Refresh and try again.",
  ],
  mediaRetry: [
    "连接未完成，请重新连接。",
    "Could not connect. Try reconnecting.",
  ],
  mediaBusy: ["连接正在更新，请稍候。", "Updating connection. Please wait."],
  shareChanged: [
    "共享已停止或正在恢复。",
    "Sharing stopped or is reconnecting.",
  ],
  unsupported: [
    "请使用支持屏幕共享的桌面浏览器。",
    "Use a desktop browser that supports screen sharing.",
  ],
  shareCancelled: [
    "未开启共享，请允许屏幕访问后重试。",
    "Screen access was not granted. Try again.",
  ],
  captureUnavailable: [
    "无法读取此来源，请重新选择。",
    "Cannot capture this source. Choose another.",
  ],
  noCandidates: [
    "未找到连接地址，请检查网络后重试。",
    "No connection path found. Check your network.",
  ],
  mediaTimeout: [
    "连接超时，请检查网络后重试。",
    "Connection timed out. Check your network.",
  ],
} as const satisfies Record<string, readonly [string, string]>;

export type TextKey = keyof typeof messages;

export function preferredLanguage(
  saved: string | null,
  browser: string,
): Language {
  if (saved === "zh" || saved === "en") return saved;
  return browser.toLowerCase().startsWith("en") ? "en" : "zh";
}

let language: Language = "zh";
if (typeof window !== "undefined") {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem("piik:language");
  } catch {
    /* Storage may be disabled. */
  }
  language = preferredLanguage(saved, navigator.language);
}

export const currentLanguage = () => language;
export function setLanguage(value: Language) {
  language = value;
  try {
    localStorage.setItem("piik:language", value);
  } catch {
    /* Keep the in-memory choice. */
  }
}
export function translate(key: TextKey, selected: Language): string {
  return messages[key][selected === "zh" ? 0 : 1];
}
export const t = (key: TextKey) => translate(key, language);

export class UiError extends Error {
  constructor(readonly key: TextKey) {
    super(key);
  }
}

const errors: Record<string, TextKey> = {
  NETWORK: "networkError",
  INVALID_RESPONSE: "responseError",
  ACCESS_DENIED: "accessDenied",
  INVITE_INVALID: "inviteInvalid",
  ROOM_NOT_FOUND: "roomNotFound",
  ROOM_ENDED: "ended",
  ROOM_FULL: "roomFull",
  ROOM_LIMIT: "roomLimit",
  KICKED: "kicked",
  LEFT: "left",
  EXPIRED: "accessDenied",
  HOST_ONLY: "hostOnly",
  VIEWER_ONLY: "viewerOnly",
  TARGET_INVALID: "invalidRequest",
  ORIGIN_DENIED: "invalidRequest",
  INVALID_REQUEST: "invalidRequest",
  INVALID_JSON: "invalidRequest",
  JSON_REQUIRED: "invalidRequest",
  BODY_TOO_LARGE: "invalidRequest",
  NOT_FOUND: "roomNotFound",
  INTERNAL: "unavailable",
  SFU_NOT_CONFIGURED: "unavailable",
  SFU_UNAVAILABLE: "unavailable",
  SFU_ABSENT: "mediaRetry",
  SFU_INVALID: "mediaRetry",
  SFU_UNREACHABLE: "mediaRetry",
  SFU_TRACK_ERROR: "mediaRetry",
  TURN_UNAVAILABLE: "mediaRetry",
  TURN_INVALID: "mediaRetry",
  MEDIA_STALE: "mediaRetry",
  ANSWER_REQUIRED: "mediaRetry",
  MEDIA_BUSY: "mediaBusy",
  CLEANUP_PENDING: "mediaBusy",
  SHARE_CHANGED: "shareChanged",
  TICKET_INVALID: "mediaRetry",
  WEBSOCKET_REQUIRED: "mediaRetry",
};
export const apiErrorKey = (code: string): TextKey =>
  Object.hasOwn(errors, code) ? errors[code]! : "genericError";
