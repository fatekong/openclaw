/**
 * Plugin Loader — jiti 动态加载 + 调用 register(api)
 *
 * 对应 openclaw: src/plugins/loader.ts
 *
 * 职责（与原版一致）：
 *   调用 discoverOpenClawPlugins 获取候选项，
 *   用 jiti 动态 import 入口文件，解析 register/activate，
 *   构造 OpenClawPluginApi 并调用 register(api)，
 *   将 registerChannel 的结果写入 PluginRegistry。
 *
 * plugin-sdk 依赖说明：
 *   全局插件（qqbot/feishu/dingtalk 等）导入 "openclaw/plugin-sdk"，
 *   jiti 需要 alias 将其映射到实际文件。
 *   解析顺序：
 *     1. 环境变量 OPENCLAW_ROOT（推荐在 VSCode launch.json 中设置）
 *     2. 向上遍历目录树查找包含 src/plugin-sdk/root-alias.cjs 的目录
 *
 * 简化说明（相比 openclaw 原版省略的部分）：
 *   - registry 缓存（registryCache）
 *   - normalizePluginsConfig / applyTestPluginDefaults
 *   - PluginRuntime Proxy 懒加载
 *   - loadPluginManifestRegistry（合并 manifest）
 *   - validateJsonSchemaValue（schema 校验）
 *   - openBoundaryFileSync（路径安全）
 *   - initializeGlobalHookRunner
 *   - clearPluginCommands
 *   - plugin-sdk alias 根路径：已实现（resolvePluginSdkAliasForDemo → root-alias.cjs）
 *   - plugin-sdk alias 子路径：已实现（resolvePluginSdkScopedAliasMapForDemo → src/plugin-sdk/xxx.ts）
 */

import { createJiti } from "jiti";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { discoverOpenClawPlugins } from "./discovery.js";
import { createPluginRegistry, type PluginRegistry } from "./registry.js";
import type { OpenClawPluginApi, OpenClawPluginDefinition, ChannelPlugin, InboundMessage } from "../types.js";

/** 消息处理回调（与 lifecycle.ts 中的 OnMessageCallback 一致） */
export type OnMessageCallback = (msg: InboundMessage) => Promise<void>;

/**
 * 解析 openclaw 根目录（含 src/plugin-sdk/root-alias.cjs 的目录）
 *
 * 解析顺序：
 *   1. 环境变量 OPENCLAW_ROOT — VSCode launch.json 里设置最稳定
 *   2. 向上遍历目录树，找到包含 src/plugin-sdk/root-alias.cjs 的目录
 *      （自动适配任意目录结构，不硬编码层级）
 */
function resolveOpenClawRoot(): string | null {
  // 1. 环境变量优先
  const envRoot = process.env.OPENCLAW_ROOT?.trim();
  if (envRoot) {
    const resolved = path.resolve(envRoot);
    if (fs.existsSync(path.join(resolved, "src", "plugin-sdk", "root-alias.cjs"))) {
      return resolved;
    }
    console.warn(`[loader] OPENCLAW_ROOT=${envRoot} set but src/plugin-sdk/root-alias.cjs not found there`);
  }

  // 2. 从当前文件向上遍历查找（最多 8 级，防止到根目录）
  let cursor = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(cursor, "src", "plugin-sdk", "root-alias.cjs");
    if (fs.existsSync(candidate)) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {break;} // 已到根
    cursor = parent;
  }

  return null;
}

/**
 * 解析 openclaw/plugin-sdk 根路径 alias（root-alias.cjs）
 * 对应 openclaw loader.ts:112 resolvePluginSdkAlias()
 */
function resolvePluginSdkAliasForDemo(): string | null {
  const openclawRoot = resolveOpenClawRoot();
  if (!openclawRoot) {return null;}
  const candidates = [
    path.join(openclawRoot, "src", "plugin-sdk", "root-alias.cjs"),
    path.join(openclawRoot, "dist", "plugin-sdk", "root-alias.cjs"),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/**
 * 解析所有 openclaw/plugin-sdk/xxx 子路径 alias
 * 对应 openclaw loader.ts:146 resolvePluginSdkScopedAliasMap()
 *
 * 原版逻辑：
 *   1. 读 package.json exports，找所有 ./plugin-sdk/xxx 条目
 *   2. 每个 subpath 尝试找 src/plugin-sdk/xxx.ts（开发态）或 dist/plugin-sdk/xxx.js（生产态）
 *   3. 写入 alias map："openclaw/plugin-sdk/xxx" → 绝对路径
 *
 * 这样 feishu 等插件的 import { ... } from "openclaw/plugin-sdk/account-id"
 * 就能被 jiti 正确解析。
 */
function resolvePluginSdkScopedAliasMapForDemo(): Record<string, string> {
  const openclawRoot = resolveOpenClawRoot();
  const aliasMap: Record<string, string> = {};
  if (!openclawRoot) {return aliasMap;}

  // Step 1：读 package.json exports（对应 loader.ts:130 pkgRaw）
  let subpaths: string[] = [];
  try {
    const pkgRaw = fs.readFileSync(path.join(openclawRoot, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgRaw) as { exports?: Record<string, unknown> };
    subpaths = Object.keys(pkg.exports ?? {})
      .filter((key) => key.startsWith("./plugin-sdk/"))
      .map((key) => key.slice("./plugin-sdk/".length))
      .filter((subpath) => Boolean(subpath) && !subpath.includes("/"))
      .toSorted();
  } catch {
    return aliasMap;
  }

  // Step 2 & 3：为每个 subpath 找源文件（对应 loader.ts:149-155）
  for (const subpath of subpaths) {
    // 优先 src（开发态），其次 dist（生产态）
    const candidates = [
      path.join(openclawRoot, "src", "plugin-sdk", `${subpath}.ts`),
      path.join(openclawRoot, "dist", "plugin-sdk", `${subpath}.js`),
    ];
    const resolved = candidates.find((c) => fs.existsSync(c));
    if (resolved) {
      aliasMap[`openclaw/plugin-sdk/${subpath}`] = resolved;
    }
  }

  return aliasMap;
}


/**
 * openclaw: PluginLoadOptions (loader.ts:37)
 *
 * 扫描来源对齐原版四级路径：
 *   pluginsDir  → origin "config"    （demo 本地插件目录，传给 extraPaths[0]）
 *   workspaceDir → origin "workspace" （workspaceDir/.openclaw/extensions）
 *   extraPaths  → origin "config"    （任意额外路径）
 *   globalDir   → origin "global"    （~/.openclaw/extensions，自动扫描，无需指定）
 */
export type PluginLoadOptions = {
  /** demo 本地插件目录（可选），作为 config 来源 */
  pluginsDir?: string;
  /** 工作区根目录（可选），扫描 workspaceDir/.openclaw/extensions */
  workspaceDir?: string;
  /** 额外扫描路径（可选，与 openclaw plugins.load.paths 对应） */
  extraPaths?: string[];
  /**
   * 消息处理回调（注入到 api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher）
   *
   * qqbot 等插件不走 ctx.onMessage，而是通过 api.runtime 保存的 pluginRuntime 调用
   * dispatchReplyWithBufferedBlockDispatcher()。
   * 通过此选项把 processMessage 注入进去，使 runtime stub 能真正处理消息。
   */
  onMessage?: OnMessageCallback;
};

// ─── 内部辅助 ──────────────────────────────────────────────────────────────

/**
 * 解析插件模块的导出，提取 register/activate 函数
 * openclaw: resolvePluginModuleExport() (loader.ts:196)
 *
 * 支持：
 *   - 默认导出是函数     → 直接作为 register（loader.ts:207）
 *   - 默认导出是对象     → 取 .register 或 .activate（loader.ts:212）
 *   - 命名导出 register  → 直接使用
 */
function resolvePluginModuleExport(
  mod: unknown,
): ((api: OpenClawPluginApi) => void) | null {
  // 处理 ESM default export 包装（loader.ts:200-205）
  const resolved =
    mod &&
    typeof mod === "object" &&
    "default" in (mod as Record<string, unknown>)
      ? (mod as { default: unknown }).default
      : mod;

  if (typeof resolved === "function") {
    return resolved as (api: OpenClawPluginApi) => void;
  }

  if (resolved && typeof resolved === "object") {
    const def = resolved as OpenClawPluginDefinition;
    return def.register ?? def.activate ?? null;
  }

  return null;
}

// ─── 主要导出 ──────────────────────────────────────────────────────────────

/**
 * 加载所有插件，返回填充好的 PluginRegistry
 * openclaw: loadOpenClawPlugins() (loader.ts:447)
 *
 * 流程（与原版对齐）：
 *   1. createPluginRegistry()             ← registry.ts:185
 *   2. discoverOpenClawPlugins()          ← discovery.ts:618
 *   3. for each candidate:
 *      a. jiti(source)                   ← loader.ts:663 getJiti()(safeSource)
 *      b. resolvePluginModuleExport(mod)  ← loader.ts:672
 *      c. register(api)                  ← loader.ts:776
 *
 * @param options.pluginsDir  插件目录
 */
export function loadOpenClawPlugins(options: PluginLoadOptions): PluginRegistry {
  // Step 1：创建注册表（loader.ts:503 createPluginRegistry）
  const registry = createPluginRegistry();

  // Step 2：探索插件候选项（loader.ts:509 discoverOpenClawPlugins）
  // 四级路径：config(pluginsDir+extraPaths) → workspace → bundled(跳过) → global(自动)
  const { candidates, diagnostics } = discoverOpenClawPlugins({
    pluginsDir: options.pluginsDir,
    workspaceDir: options.workspaceDir,
    extraPaths: options.extraPaths,
  });

  for (const diag of diagnostics) {
    if (diag.level === "error") {
      console.error(`[discovery] ${diag.message}`);
    } else {
      console.debug(`[discovery] ${diag.message}`);
    }
  }

  const sourceDesc = [
    options.pluginsDir && `pluginsDir(${options.pluginsDir})`,
    options.workspaceDir && `workspace(${options.workspaceDir})`,
    "global(~/.openclaw/extensions)",
  ]
    .filter(Boolean)
    .join(", ");
  console.log(`[loader] found ${candidates.length} plugin candidate(s) from: ${sourceDesc}`);

  // jiti 实例（loader.ts:538 createJiti）
  // 配置 openclaw/plugin-sdk alias，使全局插件（~/.openclaw/extensions/）能正常加载
  // 根路径 alias（openclaw/plugin-sdk → root-alias.cjs）
  const pluginSdkAlias = resolvePluginSdkAliasForDemo();
  // 子路径 alias（openclaw/plugin-sdk/xxx → src/plugin-sdk/xxx.ts）
  // 对应 openclaw loader.ts:543-546
  const jitiAlias: Record<string, string> = {
    ...(pluginSdkAlias ? { "openclaw/plugin-sdk": pluginSdkAlias } : {}),
    ...resolvePluginSdkScopedAliasMapForDemo(),
  };
  if (pluginSdkAlias) {
    const subpathCount = Object.keys(jitiAlias).length - 1;
    console.debug(`[loader] plugin-sdk alias → root + ${subpathCount} subpath(s)`);
  } else {
    console.warn(`[loader] plugin-sdk alias not found; plugins importing openclaw/plugin-sdk may fail`);
  }
  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs"],
    alias: jitiAlias,
  });

  // Step 3：逐个加载（对应 loader.ts 中对每个 candidate 的处理循环）
  for (const candidate of candidates) {
    const { idHint, source, manifest } = candidate;

    console.log(`[loader] loading plugin "${idHint}" from ${source}`);

    // a. jiti 动态 import（loader.ts:663 getJiti()(safeSource)）
    let mod: unknown;
    try {
      mod = jiti(source);
    } catch (err) {
      console.error(`[loader] failed to import plugin "${idHint}":`, err);
      continue;
    }

    // b. 解析 register/activate（loader.ts:672 resolvePluginModuleExport）
    const register = resolvePluginModuleExport(mod);
    if (!register) {
      console.warn(`[loader] plugin "${idHint}" has no register/activate export, skipping`);
      continue;
    }

    // c. 构造 OpenClawPluginApi 并调用 register(api)（loader.ts:769 createApi + register(api)）
    const api: OpenClawPluginApi = {
      // ── 元数据（loader.ts:769）
      id: idHint,
      name: manifest?.name ?? idHint,
      source,

      // ── 配置与运行时（demo 均为 stub 空值）
      // 原版 config 为完整 OpenClawConfig；demo 给空对象防止 api.config.xxx 报错
      config: {},
      pluginConfig: undefined,
      // 原版 runtime 提供 reply.dispatch、channel.activity、channel.routing 等能力。
      // demo 提供完整的 channel stub，支持 qqbot/dingtalk 等插件的所有调用：
      //   qqbot:    pluginRuntime.channel.routing.resolveAgentRoute()
      //             pluginRuntime.channel.reply.resolveEnvelopeFormatOptions()
      //             pluginRuntime.channel.reply.formatInboundEnvelope()
      //             pluginRuntime.channel.reply.finalizeInboundContext()
      //             pluginRuntime.channel.reply.resolveEffectiveMessagesConfig()
      //             pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher() ← 真正发消息
      //   dingtalk: pluginRuntime.channel.activity.record()
      //   feishu:   runtime.xxx (通过 setFeishuRuntime 保存)
      runtime: {
        channel: {
          // ── activity：记录 inbound/outbound 事件（no-op）──────────────────
          activity: {
            record: (..._args: unknown[]) => {
              // no-op stub，对应 PluginRuntime["channel"]["activity"]["record"]
            },
          },

          // ── routing：解析 agent 路由（返回最小 stub）────────────────────
          routing: {
            /**
             * qqbot gateway.ts:632
             * 原版查 cfg 里的 routing 配置，决定把消息发给哪个 agent。
             * demo 直接返回默认路由，使 sessionKey/accountId 正常可用。
             */
            resolveAgentRoute: (opts: {
              cfg: unknown;
              channel: string;
              accountId: string;
              peer: { kind: string; id: string };
            }) => ({
              sessionKey: `${opts.channel}:${opts.accountId}:${opts.peer.id}`,
              accountId: opts.accountId,
              agentId: "default",
            }),
          },

          // ── reply：消息格式化 + 分发（核心）───────────────────────────────
          reply: {
            /**
             * qqbot gateway.ts:642
             * 返回 envelope 格式选项（时间戳格式、from 格式等）。
             * demo 返回空对象，qqbot 会用默认值。
             */
            resolveEnvelopeFormatOptions: (_cfg: unknown) => ({}),

            /**
             * qqbot gateway.ts:824
             * 把 {from, timestamp, body, ...} 格式化为 Body 字符串。
             * 原版会加 from 前缀、时间戳等；demo 直接返回 body 文本。
             */
            formatInboundEnvelope: (opts: {
              body?: string;
              from?: string;
              [key: string]: unknown;
            }) => opts.body ?? "",

            /**
             * qqbot gateway.ts:985
             * 原版对 ctx 做最终的字段补全/规范化；demo 透传原样返回。
             */
            finalizeInboundContext: (ctx: unknown) => ctx,

            /**
             * qqbot gateway.ts:1063
             * 返回有效的消息配置（responsePrefix 等）。
             * demo 返回最小配置，responsePrefix 为空字符串。
             */
            resolveEffectiveMessagesConfig: (_cfg: unknown, _agentId?: string) => ({
              responsePrefix: "",
            }),

            /**
             * qqbot gateway.ts:1107（核心分发入口）
             * 原版调用 LLM agent，流式推送结果给 deliver 回调。
             * demo：从 ctx.BodyForAgent/Body 取文本，调用 options.onMessage，
             * 把结果通过 dispatcherOptions.deliver({text}, {kind:"final"}) 发出。
             *
             * 参数对应 qqbot 调用：
             *   ctx = ctxPayload（含 BodyForAgent, From, SessionKey, AccountId 等）
             *   cfg = openclaw config
             *   dispatcherOptions.deliver(payload, info) — payload.text 是要发给用户的文本
             */
            dispatchReplyWithBufferedBlockDispatcher: async (params: {
              ctx: Record<string, unknown>;
              cfg: unknown;
              dispatcherOptions: {
                deliver: (payload: { text?: string }, info: { kind: string }) => Promise<void>;
                onError?: (err: unknown, info: unknown) => void;
                [key: string]: unknown;
              };
              [key: string]: unknown;
            }) => {
              const { ctx: msgCtx, dispatcherOptions } = params;
              const text = String(msgCtx.BodyForAgent ?? msgCtx.Body ?? "");
              const from = String(msgCtx.From ?? msgCtx.SessionKey ?? "unknown");
              const channel = String(msgCtx.OriginatingChannel ?? msgCtx.Provider ?? "unknown");
              const accountId = String(msgCtx.AccountId ?? "default");
              const sessionKey = String(msgCtx.SessionKey ?? from);

              const onMessageFn = options.onMessage;
              if (!onMessageFn) {
                console.warn(`[loader:runtime] dispatchReplyWithBufferedBlockDispatcher called but no onMessage injected`);
                await dispatcherOptions.deliver({ text: "（no agent configured）" }, { kind: "final" });
                return;
              }

              try {
                let replyText = "";
                // 构造标准 InboundMessage，reply 函数收集回复文本
                const msg: InboundMessage = {
                  text,
                  from: sessionKey,   // sessionKey 更能唯一标识用户（含 channel:account:peer）
                  channel,
                  accountId,
                  reply: async (t: string) => { replyText = t; },
                };
                await onMessageFn(msg);
                await dispatcherOptions.deliver({ text: replyText }, { kind: "final" });
              } catch (err) {
                const errText = `错误：${err instanceof Error ? err.message : String(err)}`;
                dispatcherOptions.onError?.(err, { kind: "agent-dispatch" });
                await dispatcherOptions.deliver({ text: errText }, { kind: "final" });
              }
            },
          },
        },
        config: {
          writeConfigFile: async (_cfg: unknown) => {
            // no-op stub，对应 PluginRuntime["config"]["writeConfigFile"]
          },
        },
      },

      // ── 日志（完整实现）
      logger: {
        debug: (...args: unknown[]) => console.debug(`[plugin:${idHint}]`, ...args),
        info: (...args: unknown[]) => console.log(`[plugin:${idHint}]`, ...args),
        warn: (...args: unknown[]) => console.warn(`[plugin:${idHint}]`, ...args),
        error: (...args: unknown[]) => console.error(`[plugin:${idHint}]`, ...args),
      },

      // ── 核心：registerChannel（完整实现）
      // 原版支持 { plugin: ChannelPlugin } 或直接传 ChannelPlugin 两种形式
      // (src/plugins/types.ts:283)
      registerChannel: (registration: { plugin: ChannelPlugin } | ChannelPlugin) => {
        const plugin =
          registration && typeof registration === "object" && "plugin" in registration
            ? (registration as { plugin: ChannelPlugin }).plugin
            : (registration);
        registry.registerChannel(idHint, plugin, source);
      },

      // ── 以下均为 stub：调用不报错，功能被丢弃 ─────────────────────────

      // AI agent 工具（src/plugins/types.ts:273）
      registerTool: (..._args: unknown[]) => {
        console.debug(`[loader] plugin "${idHint}" called registerTool (stub)`);
      },

      // 生命周期钩子 - 旧版接口（src/plugins/types.ts:277）
      registerHook: (..._args: unknown[]) => {
        console.debug(`[loader] plugin "${idHint}" called registerHook (stub)`);
      },

      // HTTP 路由（src/plugins/types.ts:282）
      registerHttpRoute: (..._args: unknown[]) => {
        console.debug(`[loader] plugin "${idHint}" called registerHttpRoute (stub)`);
      },

      // 网关 RPC 方法（src/plugins/types.ts:284）
      // dingtalk 用此注册 dingtalk-connector.status 等远程调用入口
      registerGatewayMethod: (method: string, _handler: (...args: unknown[]) => unknown) => {
        console.debug(`[loader] plugin "${idHint}" called registerGatewayMethod("${method}") (stub)`);
      },

      // CLI 子命令（src/plugins/types.ts:285）
      registerCli: (..._args: unknown[]) => {
        console.debug(`[loader] plugin "${idHint}" called registerCli (stub)`);
      },

      // 后台服务（src/plugins/types.ts:286）
      registerService: (..._args: unknown[]) => {
        console.debug(`[loader] plugin "${idHint}" called registerService (stub)`);
      },

      // AI 模型 provider（src/plugins/types.ts:287）
      registerProvider: (..._args: unknown[]) => {
        console.debug(`[loader] plugin "${idHint}" called registerProvider (stub)`);
      },

      // 自定义命令，绕过 LLM（src/plugins/types.ts:293）
      registerCommand: (..._args: unknown[]) => {
        console.debug(`[loader] plugin "${idHint}" called registerCommand (stub)`);
      },

      // 上下文引擎（src/plugins/types.ts:295）
      registerContextEngine: (..._args: unknown[]) => {
        console.debug(`[loader] plugin "${idHint}" called registerContextEngine (stub)`);
      },

      // 路径解析（src/plugins/types.ts:299）—— 返回原路径
      resolvePath: (input: string) => input,

      // 类型安全生命周期钩子 - 新版接口（src/plugins/types.ts:301）
      on: (..._args: unknown[]) => {
        console.debug(`[loader] plugin "${idHint}" called on() (stub)`);
      },
    };

    try {
      register(api);
      console.log(`[loader] plugin "${idHint}" register() completed`);
    } catch (err) {
      console.error(`[loader] plugin "${idHint}" register() threw:`, err);
    }
  }

  return registry;
}
