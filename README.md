# Piik (piik-worker)

基于 Cloudflare Workers、SQLite Durable Objects 和 Realtime SFU 的私密屏幕共享。
一位房主，最多 20 位观众；通过邀请链接，在浏览器里一起看画面、听来源声音。

网站采用绿色 `p.` Logo，品牌名为 **Piik**。支持中文和英文切换；优先使用已保存的语言，否则参考浏览器语言。切换语言不会重建音视频连接。

当前实现第一阶段：建房、邀请加入、屏幕与来源声音共享、自动恢复、踢人、停止共享和结束房间。
原生远控、房间语音聊天、账号和付费套餐属于后续阶段。

公网地址：<https://piik.chius.dev>，备用地址：<https://piik-worker.chius.workers.dev>。已配置 SFU 与 TURN 短期凭据。

## 本地运行

需要 Node.js 22.18+。Node 沿用现有 nvm 环境，依赖安装在项目内。

```sh
npm ci
cp .dev.vars.example .dev.vars
```

在 `.dev.vars` 填写开发用 Realtime SFU 的 App ID 和 App Secret：

```dotenv
REALTIME_SFU_APP_ID="your-app-id"
REALTIME_SFU_BEARER_TOKEN="your-app-secret"
TURN_KEY_ID=""
TURN_API_TOKEN=""
```

此工作区已经配置开发凭据，直接启动即可，勿用示例覆盖现有文件。
凭据文件被 Git 忽略，不能提交或放入前端环境变量。

```sh
npm run dev
```

打开 <http://127.0.0.1:8787>。本项目使用 `cf` 与 `cloudflare.config.ts`；不需要新建 Wrangler 配置。
如果需要新 SFU App，先登录，再发现并检查对应命令：

```sh
npx cf auth login
npx cf cli search "create realtime SFU application"
npx cf schema realtime sfu apps create
```

可选的 TURN 凭据来自 Cloudflare Realtime TURN key。配置后，服务端签发一小时的短期连接凭据；留空时使用直接 SFU 连接与 STUN。

## 使用

1. 输入名字，创建房间，然后复制邀请链接给朋友。
2. 点击“开始共享屏幕”，在浏览器的来源选择器中选择屏幕、窗口或标签页。分享标签页声音时勾选音频选项。
3. 观众打开邀请，输入名字加入。自动播放受限时，点击画面中的播放按钮。
4. 房主可移出观众、停止共享或结束房间。移出观众会更新邀请，已有其他观众继续观看；之后邀请新朋友请重新复制链接。

房主看到的是静音预览。没有采集到声音轨道时，界面会明确提示；`audio: true` 无法保证每个系统和共享来源都能提供音频。
移动设备可作为观众，屏幕分享优先使用支持 `getDisplayMedia()` 的桌面浏览器。跨设备访问需要 HTTPS，loopback 本地开发除外。

网络恢复后，客户端重新协调房间状态并按需重建 WebRTC 连接，继续使用仍然有效的采集源。
观众刷新页面会恢复当前成员身份；房主刷新会停止旧发布，重新共享需要再次手动选择来源。

## 权限和生命周期

- 房间 ID 是定位符。房主和观众各有随机成员凭据，服务端只保存摘要，浏览器保存在每个房间的 `sessionStorage` 中。
- 邀请放在 URL fragment，首次读取后从地址栏移除。它只能授予当前房间的观众身份。
- 一个房间只有一位房主、最多 20 位有效观众；建房和加入可安全重试。观众不能发布共享画面、订阅其他房间或管理成员。
- 踢人先持久撤销权限并轮换邀请，再强制关闭该观众的 SFU 轨道；其他成员保持有效。无账号阶段不提供跨身份永久封禁，拿到新有效邀请的人仍可重新加入。
- 每个成员只有一个当前媒体连接，媒体请求有独立的连接尝试标识，过期的 SDP 和响应不能覆盖新连接。
- 暂时丢失通知 WebSocket 不会直接移除成员。HTTP 每 15 秒核对状态；无活动超过 120 秒的观众被释放，其媒体被清理。房主凭据在房间有效期内保留。
- 房间有效期为 24 小时，每个房间累计允许 200 次成员创建。每成员最多保留 4 个媒体资源记录，每房间最多 64 个；旧资源未完成清理时限制新分配。
- SFU 清理由持久记录和 DO alarm 驱动。失败采用有上限的退避间隔继续重试，不把失败当作已清理。界面会显示“仍在重试媒体清理”。
- WebSocket 使用休眠 API、单次短期票据及每成员一个通知连接；凭据不会放进通知 URL。

这是邀请制、无账号的临时共享服务。当前未实现媒体 E2EE、录制和商业账户体系。

## 验证

```sh
npm run check
```

包含生成 Worker 类型、前后端及测试类型检查、真实 Workers runtime 测试、客户端 ICE 等待及语言回归、生产构建和浏览器产物凭据检查。
ICE 收集最长等待 10 秒；若已有候选地址，即使用当前 `localDescription` 继续协商，避免不可达的其他 STUN/TURN 路径阻塞连接。没有候选地址或连接已关闭时仍明确失败。
运行时测试替换 SFU HTTP 边界，覆盖并发人数、跨房间授权、发布订阅、过期媒体、停止与踢人的竞态、失败清理、DO 重建以及 WebSocket 休眠。

已用 Chrome 验证中英文桌面和手机排版、语言偏好保存、邀请复制和权限/踢人提示；实际音视频传输中切换语言，连接和采集源保持不变。
公网部署后，已用 Chrome 验证房主发布和观众接收；强制观众走 TURN 中继时，动态视频解码与音频能量均有效。
两端同时离线 30 秒后，约 29 秒恢复画面和声音，每端仅新增一个连接，房主采集源保持不变。
本轮还使用本机 Chrome 和真实 Cloudflare SFU 验证了 20 个观众的动态视频解码与有效音频能量；
关闭观众端对控制通知的处理后，服务端踢人仍使其视频和音频接收字节停止增长，其他观众继续接收。
媒体测试使用 1280×720 动态 Canvas 和合成音频，验证媒体链路，不代表已经验证所有操作系统的真实屏幕音频来源。
修正清理与恢复的执行顺序后，另以一位房主、三位观众验证浏览器离线 35 秒再上线：约 12 秒恢复画面和声音，
每端只新建一个连接，房主原有采集源保持不变。测试房间在验证后已结束。

依赖使用 lockfile 固定。开发工具链的 `zod`、`undici` 采用修复安全公告的 patch 版本覆盖，`npm audit` 当前无已知漏洞。

## 代码结构

| 位置                     | 职责                                                 |
| ------------------------ | ---------------------------------------------------- |
| `src/index.ts`           | 同源检查、输入限制、HTTP 路由与类型化 DO RPC         |
| `src/server/room.ts`     | SQLite 房间权威、媒体生命周期、清理 alarm 和休眠通知 |
| `src/server/sfu.ts`      | 只在服务端使用的 SFU API 与逐轨道错误检查            |
| `src/shared/protocol.ts` | 请求/响应验证与前后端协议                            |
| `src/client/main.ts`     | 房间页面、采集、播放、通知和媒体恢复                 |
| `src/client/media.ts`    | 浏览器 ICE 收集与连接等待                            |
| `src/client/i18n.ts`     | 中英文文案、偏好和错误提示映射                        |
| `public/logo.svg`        | 网站 Logo 与标签页图标                              |
| `tests/runtime`          | Workers runtime 的权限和生命周期回归测试             |

控制消息通过 Workers/DO，音视频直接在浏览器与 SFU 之间传输。当前不需要 D1、R2 或 KV。
初始产品分析、服务选型与成本模型见 [架构研究](docs/research.zh-CN.md)。

`npm run build` 仅构建；`npm run deploy` 使用 cf 发布到你选择的 Cloudflare 账号。
已于 2026-10-25 发布至 Cloudflare，当前版本 `5a861501-d4d7-4adf-a16c-72f9f0e3a7a8`。
发布使用 `cf deploy --prebuilt --secrets-file .dev.vars`；密钥仅进入 Worker 服务端绑定。
`cloudflare.config.ts` 通过 `domains` 维护 `piik.chius.dev` 自定义域名，并保留 workers.dev 备用地址；Cloudflare 自动管理 DNS 和 TLS。
