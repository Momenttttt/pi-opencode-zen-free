/**
 * opencode-zen-free — 让 pi 正常调用 OpenCode Zen 免费层模型
 *
 * Zen 免费层（https://opencode.ai/zen/v1）对 -free 模型做了客户端身份门禁，
 * 请求必须同时满足三个条件，否则 403 FreeTierError：
 *   1. 流式（stream: true）
 *   2. 请求体 tools 数组里同时有 bash 和 read 两个 function
 *   3. 携带 opencode CLI 的指纹头（User-Agent: opencode/<ver> ...、
 *      x-opencode-client: cli、x-opencode-session: ses_...、x-opencode-request: msg_...）
 *
 * 本扩展分两层处理：
 *
 * 第一层（官方事件）：监听 before_provider_headers，覆盖 pi 自己发的
 * x-opencode-client: "pi" 等归属头，补齐全部指纹头。主 agent 循环走这层。
 *
 * 第二层（fetch 兜底）：archimedes session-name、pi-web-access 这类扩展的
 * 旁路调用不走 provider 管线，事件管不到，只能在这层拦。只处理发往
 * /zen/v1 且头里还没有 x-opencode-client: cli 的请求（说明事件层没碰过），
 * 除注入头外还会给无 tools 的 JSON 正文补两个占位工具——门禁连会话命名
 * 这种请求也要求带 bash/read。
 *
 * 两层都只作用于 opencode.ai 的免费端点 /zen/v1（URL 解析后 hostname 精确
 * 匹配），不碰付费的 /zen/go/v1。出错时静默跳过，不影响请求本身。
 * 调试：PI_ZEN_FREE_DEBUG=1。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── 客户端版本指纹：三个号描述同一份 opencode 发布，必须成套改（来源见 README「版本维护」）──
// opencode 主版本号：https://github.com/anomalyco/opencode/releases
const OPENCODE_VERSION = "1.18.31";
// 该版本捆绑的 @ai-sdk/provider-utils 版本号（真实 UA 里 ai-sdk/ 段）
const PROVIDER_UTILS_VERSION = "4.0.40";
// 构建该版本的 Bun 运行时版本号（真实 UA 里 runtime/bun 段）
const BUN_VERSION = "1.3.14";

const USER_AGENT = `opencode/${OPENCODE_VERSION} ai-sdk/provider-utils/${PROVIDER_UTILS_VERSION} runtime/bun/${BUN_VERSION}`;

const DEBUG = process.env.PI_ZEN_FREE_DEBUG === "1";

const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let counter = 0;
let lastTimestamp = 0;

/**
 * 生成 opencode CLI 格式的 ID（ses_/msg_ 前缀）：
 * 6 字节时间戳（48bit，可降序编码）+ 14 位 base62 随机。
 * 与 opencode 客户端 generateId() 的输出格式一致。
 */
function generateId(prefix: "ses" | "msg", descending: boolean, timestamp = Date.now()): string {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;

  const current = BigInt(timestamp) * 0x1000n + BigInt(counter);
  const value = descending ? ~current : current;
  const timeHex = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  ).join("");

  const bytes = crypto.getRandomValues(new Uint8Array(14));
  const rand = Array.from(bytes, (b) => ID_CHARS[b % 62]).join("");
  return `${prefix}_${timeHex}${rand}`;
}

/** 只匹配 Zen 免费端点：hostname 精确等于 opencode.ai 且路径在 /zen/v1 下（排除付费 /zen/go/v1）。 */
function isZenFreeEndpoint(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string" || baseUrl === "") return false;
  try {
    const url = new URL(baseUrl);
    return (
      url.hostname === "opencode.ai" &&
      (url.pathname === "/zen/v1" || url.pathname.startsWith("/zen/v1/"))
    );
  } catch {
    return false;
  }
}

/**
 * 门禁要求的占位工具定义。旁路调用（会话命名、联网搜索）本身不带工具，
 * 补两个最小化的 bash/read 定义骗过校验；模型不会真的调用它们。
 */
const PLACEHOLDER_TOOLS = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Runs a command in a persistent shell session",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "The command to run" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description: "Reads a file from the local filesystem",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "The absolute path to the file to read" } },
        required: ["path"],
      },
    },
  },
] as const;

function readHeader(headers: HeadersInit | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  try {
    return new Headers(headers).get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

/** 用一组新头替换旧 headers（大小写不敏感），返回新的 Headers 实例。 */
function withHeaders(headers: HeadersInit | undefined, toSet: Record<string, string>): Headers {
  const result = new Headers(headers ?? undefined);
  for (const [name, value] of Object.entries(toSet)) result.set(name, value);
  return result;
}

// fetch 兜底层标记，/reload 重载扩展时不重复包裹
const PATCHED = Symbol("opencode-zen-free");

function patchFetchForSideCalls(sessionId: string): void {
  const current = globalThis.fetch as ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) & {
    [PATCHED]?: boolean;
  };
  if (!current || current[PATCHED]) return;

  const originalFetch = current;
  const patched = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    try {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input instanceof Request
              ? input.url
              : undefined;
      // 只管 zen 免费端点；事件层已处理过的请求（头里带 cli）直接放行
      if (typeof url !== "string" || !isZenFreeEndpoint(url)) {
        return originalFetch(input, init);
      }
      init = init ?? {};
      if (readHeader(init.headers, "x-opencode-client") === "cli") {
        return originalFetch(input, init);
      }

      init.headers = withHeaders(init.headers, {
        "User-Agent": USER_AGENT,
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        "x-opencode-session": sessionId,
        "x-opencode-request": generateId("msg", false),
      });

      // 无 tools 的 JSON 正文补占位工具（fetch 会按 spec 重算 Content-Length，不用手动改）
      if (typeof init.body === "string") {
        try {
          const body: unknown = JSON.parse(init.body);
          if (
            body &&
            typeof body === "object" &&
            !Array.isArray(body) &&
            (body as { model?: unknown }).model !== undefined &&
            !("tools" in body)
          ) {
            (body as { tools?: unknown }).tools = PLACEHOLDER_TOOLS;
            init.body = JSON.stringify(body);
          }
        } catch {
          // 非 JSON 正文，不动
        }
      }

      if (DEBUG) console.error(`[opencode-zen-free] fetch 兜底已处理 ${url}`);
    } catch (err) {
      // 兜底层出错只记日志，不影响请求
      if (DEBUG) console.error("[opencode-zen-free] fetch 兜底跳过：", err);
    }
    return originalFetch(input, init);
  } as typeof current & { [PATCHED]?: boolean };
  patched[PATCHED] = true;
  globalThis.fetch = patched;
}

export default function (pi: ExtensionAPI) {
  // 每个 pi 进程持有一个稳定会话 ID（真实 opencode 也是每会话一个），时间戳回拨 3 秒以示区分
  const sessionId = generateId("ses", true, Date.now() - 3000);

  patchFetchForSideCalls(sessionId);

  pi.on("before_provider_headers", (event, ctx) => {
    try {
      const model = ctx.model;
      if (!model || !isZenFreeEndpoint(model.baseUrl)) return;

      event.headers["User-Agent"] = USER_AGENT;
      event.headers["x-opencode-client"] = "cli";
      event.headers["x-opencode-project"] = "global";
      event.headers["x-opencode-session"] = sessionId;
      event.headers["x-opencode-request"] = generateId("msg", false);

      if (DEBUG) {
        console.error(`[opencode-zen-free] ${model.provider ?? "?"}/${model.id} 已注入客户端指纹头`);
      }
    } catch (err) {
      // 注入失败只记日志，不让扩展问题影响请求
      if (DEBUG) console.error("[opencode-zen-free] 注入跳过：", err);
    }
  });
}
