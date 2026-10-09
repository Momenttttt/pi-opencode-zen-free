# pi-opencode-zen-free

让 [pi](https://pi.dev) 正常调用 OpenCode Zen 的免费模型。这些模型在 pi 里原本会收到 `403 FreeTierError`，装上这个扩展就能用了。

## 背景

OpenCode Zen 的免费模型（`step-5-preview-free`、`longcat-2.5-preview-free`、`nemotron-3-ultra-free` 等）有一道客户端身份门禁，请求要同时满足三个条件才放行：

1. 流式请求（`stream: true`）
2. `tools` 里同时带 `bash` 和 `read` 两个工具
3. 携带 opencode CLI 的指纹头：`User-Agent: opencode/<版本>`、`x-opencode-client: cli`、`x-opencode-session`、`x-opencode-request`

缺一项就 403。pi 满足前两条，但指纹头对不上，还会主动带上 `x-opencode-client: "pi"`，等于自报家门，直接被拦。目前只有 `space-bunny-free` 一个模型豁免这套校验，其余免费模型在 pi 里全都用不了。

## 安装

要求 pi 1.1.0 及以上。

```bash
pi install git:github.com/Momenttttt/pi-opencode-zen-free
```

也可以手动安装：把 `extensions/opencode-zen-free.ts` 复制到 `~/.pi/agent/extensions/`，pi 启动时自动加载。

想先试试不安装：

```bash
pi -e ./extensions/opencode-zen-free.ts
```

装好后照常选模型用就行，扩展在后台补齐门禁要的东西，不需要任何额外操作。

## 工作原理

扩展分两层干活。

第一层管主 agent 循环。它监听 pi 的 `before_provider_headers` 事件，这个事件在每个 provider 请求发出前触发，pi 合并完自己的头之后才轮到扩展改，所以能直接覆盖：

- `User-Agent` 换成 opencode CLI 的格式
- `x-opencode-client` 从 `pi` 覆盖成 `cli`
- `x-opencode-session` 换成 opencode 格式的 `ses_` 开头 ID，每个 pi 进程持有一个
- 补上 `x-opencode-request`（`msg_` 开头，每次请求新生成）和 `x-opencode-project: global`

第二层是 fetch 兜底。archimedes session-name、pi-web-access 这类扩展的旁路调用不走 provider 管线，事件管不到，它们直连 Zen 同样被门禁拦下，连给会话起个名字、从网页里提炼答案这种请求都要求带 bash/read 工具。兜底层只拦发往 `/zen/v1`、且头里还没有 `x-opencode-client: cli` 的请求，专收第一层漏下的：注入同样的指纹头，再给无 tools 的 JSON 正文补两个占位工具定义。

会话和请求 ID 的生成逻辑照搬 opencode CLI 的 `generateId()`：6 字节时间戳加 14 位随机 base62，格式逐字节一致。

两层的注入范围都精确限定在 `https://opencode.ai/zen/v1`（免费端点），匹配用 URL 解析后的 hostname 精确比较，不是字符串包含，付费的 `/zen/go/v1` 和其他任何域名都不碰。注入全程 try/catch，扩展自己出问题只写调试日志，不影响请求。

## 验证

```bash
pi --print --provider opencode --model step-5-preview-free "Reply with exactly: ok"
```

能看到回复就是通了，这个模型之前直连 403。兜底层有没有生效看 stderr：没装扩展时这条命令会附带一条 `[archimedes] session-name failed: 403`，装了之后消失。排查问题时加 `PI_ZEN_FREE_DEBUG=1`，扩展会把每次注入记录打到 stderr。

## 已知限制

- 兜底层不动 `stream` 参数。给期望 JSON 响应的调用方强行改成 SSE 会弄坏它的解析，所以非流式的旁路调用（如果有）仍会 403。目前 pi 生态内的旁路调用都走流式，实际没碰到。
- Zen 免费模型变动频繁，一部分已经下线（401/410/400），装了扩展也救不回来，那是服务端的事。

## 版本维护

> [!NOTE]
> Zen 目前只认客户端身份，不校验 opencode 版本号。哪天开始校验（表现为所有免费模型重新 403），把 `extensions/opencode-zen-free.ts` 顶部那组版本号改成最新的即可。

UA 里的三个版本号描述的是同一份 opencode 发布，要成套改，单改一个反而制造不一致：

- `OPENCODE_VERSION`：opencode 主版本号，查 [官方 release](https://github.com/anomalyco/opencode/releases)
- `PROVIDER_UTILS_VERSION`：该版本捆绑的 `@ai-sdk/provider-utils` 依赖版本，在 npm 上看对应版本 opencode 包的 dependencies，或翻仓库里该 tag 的 `packages/opencode/package.json`
- `BUN_VERSION`：构建该版本的 Bun 运行时版本，仓库里没有醒目的出处

后两个不好找的话有个省事的办法：抓一次真实 opencode CLI 的请求（比如过一遍本地代理），把它发出的 `User-Agent` 原样抄下来拆成三个号，保证和线上形态一致。

## 风险

> [!WARNING]
> 这个扩展伪装成 opencode CLI 来通过免费层的客户端校验，属于绕过服务端门禁，理论上违反 OpenCode 服务条款，极端情况可能封 key 或封账号，自担风险。想稳妥就用付费的 opencode-go，不需要任何扩展。
