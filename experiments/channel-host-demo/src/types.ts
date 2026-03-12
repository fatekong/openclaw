/**
 * 类型层：与 openclaw 主工程接口对齐的最小类型定义
 *
 * 策略说明：
 * - 纯类型文件（如 types.plugin.ts、types.core.ts）理论上可直接 import，
 *   但它们的依赖链（types.adapters.ts → OpenClawConfig → 整个 config 系统）
 *   会拉入大量运行时依赖，导致独立工程无法启动。
 * - 因此本文件自定义形状完全对齐 openclaw 接口的最小类型，
 *   注释中标注对应的 openclaw 源文件位置。
 */

// ─── 对应 src/plugins/types.ts ────────────────────────────────────────────

/**
 * openclaw: PluginLogger (src/plugins/types.ts:22)
 */
export type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

/**
 * openclaw: PluginOrigin (src/plugins/types.ts)
 * bundled = 内置插件；global = 全局安装；workspace = 工作区；config = 配置指定路径
 * Demo 工程中插件来自 config（指定 pluginsDir），统一使用 "config"
 */
export type PluginOrigin = "bundled" | "global" | "workspace" | "config";

/**
 * openclaw: PluginDiagnostic (src/plugins/types.ts)
 */
export type PluginDiagnostic = {
  level: "warn" | "error";
  message: string;
  pluginId?: string;
  source?: string;
};

// ─── 对应 src/channels/plugins/types.core.ts ──────────────────────────────

/** openclaw: ChannelId */
export type ChannelId = string;

/** openclaw: ChannelMeta */
export type ChannelMeta = {
  title: string;
  mdIcon?: string;
  icon?: string;
  color?: string;
  docsPath?: string;
};

/** openclaw: ChannelCapabilities */
export type ChannelCapabilities = {
  chatTypes: Array<"direct" | "group">;
  media?: boolean;
  supportsReplyTo?: boolean;
  supportsThreads?: boolean;
  blockStreaming?: boolean;
};

/** openclaw: ChannelAccountSnapshot */
export type ChannelAccountSnapshot = {
  accountId: string;
  enabled?: boolean;
  configured?: boolean;
  status?: string;
  [key: string]: unknown;
};

// ─── 对应 src/channels/plugins/types.adapters.ts ──────────────────────────

/**
 * openclaw: ChannelConfigAdapter (types.adapters.ts:52)
 * 使用 unknown 替代 OpenClawConfig，插件用 as 转换自己需要的字段
 */
export type ChannelConfigAdapter<ResolvedAccount = unknown> = {
  listAccountIds: (cfg: unknown) => string[];
  resolveAccount: (cfg: unknown, accountId?: string | null) => ResolvedAccount;
  isEnabled?: (account: ResolvedAccount, cfg: unknown) => boolean;
  disabledReason?: (account: ResolvedAccount, cfg: unknown) => string;
  isConfigured?: (account: ResolvedAccount, cfg: unknown) => boolean | Promise<boolean>;
  unconfiguredReason?: (account: ResolvedAccount, cfg: unknown) => string;
  defaultAccountId?: (cfg: unknown) => string;
};

/**
 * openclaw: ChannelOutboundContext (types.adapters.ts:89)
 * 发送消息时传入的参数
 */
export type ChannelOutboundContext = {
  cfg: unknown;
  to: string;
  text: string;
  mediaUrl?: string;
  replyToId?: string | null;
  accountId?: string | null;
};

/**
 * openclaw: ChannelOutboundAdapter (types.adapters.ts:108)
 */
export type ChannelOutboundAdapter = {
  deliveryMode: "direct" | "gateway" | "hybrid";
  sendText?: (ctx: ChannelOutboundContext) => Promise<{ channel: string; messageId?: string }>;
  chunker?: ((text: string, limit: number) => string[]) | null;
};

/**
 * 入站消息：Host 层标准化的消息格式
 *
 * openclaw 中没有对应的单一类型（各 channel 的 inbound 格式各异，
 * 通过 dispatchInboundReplyWithBase 分发给 agent）。
 * 本工程将其简化为统一的回调接口，承担 dispatchInboundReply 的角色。
 */
export type InboundMessage = {
  /** 发送者标识（如 user:123、nick@server） */
  from: string;
  /** 消息文本 */
  text: string;
  /** channel id（如 "demo-channel"、"irc"） */
  channel: string;
  /** 账户 ID */
  accountId: string;
  /** 便利函数：直接回复这条消息（对应 IRC 的 sendReply 回调） */
  reply: (text: string) => Promise<void>;
};

/**
 * openclaw: ChannelGatewayContext (types.adapters.ts:168)
 *
 * 相比原版的差异：
 * - cfg 类型简化为 Record<string,unknown>（原版为 OpenClawConfig）
 * - runtime 字段省略（原版为 RuntimeEnv）
 * - channelRuntime 字段省略（原版为 PluginRuntime["channel"]，可选）
 * - 新增 onMessage 字段：承担原版 dispatchInboundReply 的角色，
 *   由 lifecycle.ts 的 startChannelInternal 注入
 */
export type ChannelGatewayContext<ResolvedAccount = unknown> = {
  /** 全局配置（openclaw 中为 OpenClawConfig，本工程简化为 Record<string,unknown>） */
  cfg: Record<string, unknown>;
  accountId: string;
  account: ResolvedAccount;
  abortSignal: AbortSignal;
  getStatus: () => ChannelAccountSnapshot;
  setStatus: (next: ChannelAccountSnapshot) => void;
  log?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
  /**
   * 消息分发回调（openclaw 对应 dispatchInboundReply / dispatchInboundReplyWithBase）
   *
   * 原版通过 channelRuntime.reply.dispatchReplyFromConfig 实现 AI 调用；
   * 本工程将其简化为直接回调，由 Host 层注入具体实现（见 lifecycle.ts）。
   */
  onMessage?: (msg: InboundMessage) => Promise<void>;
};

/**
 * openclaw: ChannelGatewayAdapter (types.adapters.ts:275)
 */
export type ChannelGatewayAdapter<ResolvedAccount = unknown> = {
  startAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<unknown>;
  stopAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<void>;
};

// ─── 对应 src/channels/plugins/types.plugin.ts ────────────────────────────

/**
 * openclaw: ChannelPlugin (types.plugin.ts:49)
 * 精简版，只保留本工程需要的字段
 */
export type ChannelPlugin<ResolvedAccount = unknown> = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  config: ChannelConfigAdapter<ResolvedAccount>;
  gateway?: ChannelGatewayAdapter<ResolvedAccount>;
  outbound?: ChannelOutboundAdapter;
};

// ─── 对应 src/plugins/manifest.ts ─────────────────────────────────────────

/**
 * openclaw: PluginManifest (src/plugins/manifest.ts:11)
 * 对应 openclaw.plugin.json 文件结构
 */
export type PluginManifest = {
  id: string;
  channels?: string[];
  configSchema?: Record<string, unknown>;
  name?: string;
  description?: string;
  version?: string;
};

// ─── 对应 src/plugins/types.ts（OpenClawPluginApi 部分）───────────────────

/**
 * openclaw: OpenClawPluginApi (src/plugins/types.ts:263)
 *
 * demo 工程实现策略：
 *   - registerChannel：完整实现，写入 PluginRegistry
 *   - logger：完整实现，转发到 console
 *   - config / pluginConfig / runtime / source / version / description：stub 空值
 *   - 其余所有 register* / resolvePath / on：stub 空函数，调用不报错、不崩溃
 *
 * 这样任何插件的 register(api) 都能走完，不会因为
 * "api.registerGatewayMethod is not a function" 等错误中断。
 */
export type OpenClawPluginApi = {
  // ── 元数据字段（src/plugins/types.ts:264-268）──────────────────────────
  id: string;
  name: string;
  version?: string;
  description?: string;
  /** 插件入口文件绝对路径（src/plugins/types.ts:267） */
  source: string;

  // ── 配置与运行时（src/plugins/types.ts:269-271）────────────────────────
  /** openclaw 全局配置（demo 简化为空对象） */
  config: Record<string, unknown>;
  /** 插件私有配置（demo 简化为 undefined） */
  pluginConfig?: Record<string, unknown>;
  /**
   * PluginRuntime（src/plugins/runtime/types.ts）
   * 原版提供 reply.dispatch、agent、channel 等能力
   * demo 简化为空对象（feishu 的 setFeishuRuntime(api.runtime) 会拿到空对象而非 undefined）
   */
  runtime: Record<string, unknown>;

  // ── 日志（src/plugins/types.ts:272）────────────────────────────────────
  logger: PluginLogger;

  // ── 注册方法（src/plugins/types.ts:273-305）────────────────────────────
  /** 核心：注册 channel 插件 */
  registerChannel: (registration: { plugin: ChannelPlugin } | ChannelPlugin) => void;
  /** AI agent 工具（stub） */
  registerTool: (...args: unknown[]) => void;
  /**
   * 生命周期钩子 - 旧版接口（stub）
   * 新版通过 on() 注册；两者 demo 都 stub
   */
  registerHook: (...args: unknown[]) => void;
  /** HTTP 路由（stub） */
  registerHttpRoute: (...args: unknown[]) => void;
  /**
   * 网关 RPC 方法（stub）
   * openclaw: registerGatewayMethod(method, handler) (src/plugins/types.ts:284)
   * dingtalk 用此注册 dingtalk-connector.status 等远程调用入口
   */
  registerGatewayMethod: (method: string, handler: (...args: unknown[]) => unknown) => void;
  /** CLI 子命令（stub） */
  registerCli: (...args: unknown[]) => void;
  /** 后台服务（stub） */
  registerService: (...args: unknown[]) => void;
  /** AI 模型 provider（stub） */
  registerProvider: (...args: unknown[]) => void;
  /** 自定义命令，绕过 LLM（stub） */
  registerCommand: (...args: unknown[]) => void;
  /** 上下文引擎（stub） */
  registerContextEngine: (...args: unknown[]) => void;
  /** 解析相对路径（stub，返回原路径） */
  resolvePath: (input: string) => string;
  /**
   * 类型安全生命周期钩子 - 新版接口（stub）
   * openclaw: on<K extends PluginHookName>(hookName, handler, opts?) (src/plugins/types.ts:301)
   */
  on: (...args: unknown[]) => void;
};

/**
 * openclaw: OpenClawPluginDefinition (src/plugins/types.ts)
 * 插件模块的导出结构
 */
export type OpenClawPluginDefinition = {
  id?: string;
  register?: (api: OpenClawPluginApi) => void;
  activate?: (api: OpenClawPluginApi) => void;
};
