/**
 * Pinned Context Blocks — 钉选上下文块插件 (OpenClaw 版)
 *
 * 让用户在对话中手动锚定关键信息作为"钉选上下文块"，
 * strong 块进入 system context，context 块进入本轮临时 prompt。
 *
 * 命令：
 *   /pin add <标签> <内容>           新增块（默认 active）
 *   /pin add <标签> <内容> --pinned  新增为长期锚定块
 *   /pin list                        列出所有块（按状态分组）
 *   /pin remove <标签>               删除块
 *   /pin edit <标签> <新内容>        编辑块
 *   /pin idle <标签>                 停用块（→ idle）
 *   /pin activate <标签>             重新激活（idle → active）
 *   /pin pin <标签>                  锚定（→ pinned，永不过期）
 *   /pin unpin <标签>                取消锚定（pinned → active）
 *   /pin clear                       清空全部（需确认）
 *   /pin help                        显示帮助
 *
 * 接口层说明（对齐 OpenClaw 2026.10.2）：
 *   - 会话身份只在 handler 的第二个参数 / 命令 ctx 上，事件载荷内没有。
 *   - 存储键用 sessionKey（稳定），不用 sessionId（会话重开会变）。
 *   - 群聊判定按 sessionKey 推导，无法判定时 fail-closed 跳过注入。
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

import { Storage } from "./storage.js";
import { BlockManager } from "./block_manager.js";
import { ContextInjector } from "./injector.js";
import { deriveChatType, type ChatType } from "./chat_type.js";
import { parsePinArgs, extractPinnedFlag } from "./pin_command.js";
import { resolveScope, senderAllowed } from "./scope.js";

// ── 工具函数 ──────────────────────────────────────────

/**
 * 从 pluginConfig 读取数字。
 *
 * `api.pluginConfig` 的类型是 `Record<string, unknown>`，直接用 `??` 兜底不会做类型检查：
 * 配置里写成字符串（如 "20"）会被原样带入比较与运算，静默产生错误行为。
 * 这里显式校验，非法值回退到默认值。
 */
function readNumber(cfg: Record<string, unknown>, key: string, fallback: number): number {
  const raw = cfg[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

/** 从 pluginConfig 读取布尔值（非布尔值回退到默认值） */
function readBoolean(cfg: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof cfg[key] === "boolean" ? (cfg[key] as boolean) : fallback;
}

function readStrings(cfg: Record<string, unknown>, key: string): string[] {
  const raw = cfg[key];
  return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
}

/** 生成"会话类型不允许"的说明文本 */
function rejectText(chatType: ChatType): string {
  const name = chatType === "unknown" ? "无法判定类型" : chatType === "group" ? "群聊" : "频道";
  return `❌ ${name}会话不可用，或缺少可信的群 ID / 发言人 ID，或该群不在白名单中。`;
}

// ── 插件入口 ──────────────────────────────────────────

export default definePluginEntry({
  id: "pinned-context",
  name: "Pinned Context Blocks",
  description: "用户可控的 strong 与 context 钉选块，支持私聊和群聊作用域",

  register(api: OpenClawPluginApi) {
    // ── 初始化组件 ────────────────────────────────────
    const dataDir = api.resolvePath("./data");
    const storage = new Storage(dataDir);
    const injector = new ContextInjector();

    // 从配置读取参数
    const cfg = api.pluginConfig ?? {};
    const blockMgr = new BlockManager(storage, {
      maxBlocks: readNumber(cfg, "maxBlocksPerSession", 20),
      maxLabelLen: readNumber(cfg, "maxLabelLength", 20),
      maxContentLen: readNumber(cfg, "maxContentLength", 500),
      idleRetentionDays: readNumber(cfg, "idleRetentionDays", 7),
      idleRetentionCalls: readNumber(cfg, "idleRetentionCalls", 10),
      idleHardRetentionDays: readNumber(cfg, "idleHardRetentionDays", 30),
    });
    const tokenWarningThreshold = readNumber(cfg, "tokenWarningThreshold", 1000);
    const enableInGroup = readBoolean(cfg, "enableInGroup", false);
    const groupWhitelist = readStrings(cfg, "groupWhitelist");
    const sharedAdmins = readStrings(cfg, "groupSharedAdminIds");
    const strongUsers = readStrings(cfg, "groupStrongUserIds");

    // unknown 会话类型的一次性告警（避免每轮刷屏），上限防止无限增长
    const warnedSessions = new Set<string>();
    const warnUnknownOnce = (sessionKey: string, chatType: ChatType): void => {
      if (warnedSessions.has(sessionKey)) return;
      if (warnedSessions.size >= 200) warnedSessions.clear();
      warnedSessions.add(sessionKey);
      api.logger?.warn?.(
        `[钉选上下文] 会话 ${sessionKey} 的 chatType 判定为 ${chatType}，` +
          `已按 fail-closed 策略跳过注入。请检查频道会话键。`,
      );
    };

    api.logger?.info?.("[钉选上下文] 插件初始化完成");

    // ── 1. before_prompt_build hook — 注入钉选块 ──────
    //
    // 事件载荷（PluginHookBeforePromptBuildEvent）只有 prompt / currentUserMessage /
    // currentUserMessageId / messages 四个字段，不含任何会话标识；
    // 会话身份在第二个参数 ctx（PluginHookAgentContext）上。
    api.on(
      "before_prompt_build",
      async (_event, ctx) => {
        const sessionKey = ctx.sessionKey ?? "";
        if (!sessionKey) return;

        const scope = resolveScope({
          sessionKey, channel: ctx.channel, senderId: ctx.senderId, chatId: ctx.chatId,
        }, enableInGroup, groupWhitelist);
        if (!scope) {
          const chatType = deriveChatType(sessionKey, ctx.channel);
          if (chatType === "unknown") warnUnknownOnce(sessionKey, chatType);
          return;
        }
        const keys = scope.sharedKey ? [scope.sharedKey, scope.personalKey] : [scope.personalKey];
        for (const key of keys) {
          await blockMgr.incrementCallCount(key);
          await blockMgr.purgeStaleIdle(key);
        }
        const blocks = keys.flatMap((key) => blockMgr.getActive(key));
        if (scope.chatType === "group" && scope.sharedKey && !senderAllowed(sharedAdmins, scope, ctx.senderId ?? "") &&
            !senderAllowed(strongUsers, scope, ctx.senderId ?? "")) {
          const personal = blockMgr.getActive(scope.personalKey);
          for (const block of personal) {
            if (block.level === "strong") blocks.splice(blocks.indexOf(block), 1);
          }
        }
        if (blocks.length === 0) return;
        // Group shared blocks remain ahead of personal blocks within each level.
        const strong = injector.format(blocks, "strong", scope.chatType === "group");
        const context = injector.format(blocks, "context", scope.chatType === "group");
        return {
          ...(strong ? { appendSystemContext: strong } : {}),
          ...(context ? { appendContext: context } : {}),
        };
      },
      { priority: 50 },
    );

    // ── 2. /pin 命令 — CRUD 操作 ──────────────────────
    api.registerCommand({
      name: "pin",
      description: "管理钉选上下文块",
      // acceptsArgs 必须是 true：否则带参数的调用会被判定为 non-plugin 命令
      // 并静默漏过（plugin-command-runtime 的 prepareDispatch）。
      acceptsArgs: true,
      // Group members may manage their own soft blocks. Direct-chat auth is checked below.
      requireAuth: false,

      // 字段名是 handler，签名 handler(ctx)。ctx.args 已是纯参数，
      // 无需再手工剥离 "pin " 前缀。
      handler: async (ctx) => {
        const sessionKey = ctx.sessionKey ?? "";
        if (!sessionKey) {
          return { text: "❌ 无法获取会话标识，操作已取消。" };
        }

        const chatType = deriveChatType(sessionKey, ctx.channel);
        const scope = resolveScope({
          sessionKey, channel: ctx.channel, senderId: ctx.senderId,
        }, enableInGroup, groupWhitelist);
        if (!scope) return { text: rejectText(chatType) };
        if (scope.chatType === "direct" && !ctx.isAuthorizedSender) {
          return { text: "❌ 仅授权发送者可以管理私聊钉选块。" };
        }
        const parsed = parsePinArgs(ctx.args);
        const shared = parsed.subcommand === "shared";
        if (shared && !scope.sharedKey) return { text: "❌ shared 仅用于群聊。" };
        const { subcommand, rest } = shared ? parsePinArgs(parsed.rest) : parsed;
        const key = shared ? scope.sharedKey! : scope.personalKey;
        const sender = ctx.senderId?.trim() ?? "";
        const canSharedWrite = senderAllowed(sharedAdmins, scope, sender);
        const canStrong = canSharedWrite || senderAllowed(strongUsers, scope, sender);
        if (shared && subcommand !== "list" && subcommand !== "help" && !canSharedWrite) {
          return { text: "❌ 仅配置的群共享管理员可修改共享块。" };
        }
        if (scope.chatType === "group" && !shared && !canStrong && subcommand === "clear" &&
            Object.values(blockMgr.listAll(key)).flat().some((block) => block.level === "strong")) {
          return { text: "❌ 当前作用域包含 strong 块，仅授权用户可清空。" };
        }
        if (scope.chatType === "group" && !shared && !canStrong &&
            ["edit", "remove", "idle", "activate", "pin", "unpin", "level"].includes(subcommand)) {
          const label = rest.split(/\s+/u)[0];
          const existing = Object.values(blockMgr.listAll(key)).flat().find((block) => block.label === label);
          if (existing?.level === "strong") return { text: "❌ 当前块是 strong，仅授权用户可修改。" };
        }

        try {
          let text: string;
          switch (subcommand) {
            case "":
              text = helpText();
              break;
            case "add":
            case "add-strong":
            case "add-context": {
              const level = subcommand === "add-strong" ? "strong" : subcommand === "add-context"
                ? "context" : scope.chatType === "group" ? "context" : "strong";
              if (scope.chatType === "group" && !shared && level === "strong" && !canStrong) {
                text = "❌ 仅配置的群个人 strong 授权用户可新增强约束。";
              } else {
                text = await cmdAdd(blockMgr, key, rest, level);
              }
              break;
            }
            case "list":
              text = cmdList(blockMgr, key, tokenWarningThreshold);
              break;
            case "remove":
              text = await cmdRemove(blockMgr, key, rest);
              break;
            case "edit":
              text = await cmdEdit(blockMgr, key, rest);
              break;
            case "level": {
              const [label, level] = rest.split(/\s+/u);
              if (!label || (level !== "strong" && level !== "context")) {
                text = "用法: /pin level <标签> strong|context";
              } else if (scope.chatType === "group" && !shared && level === "strong" && !canStrong) {
                text = "❌ 仅配置的群个人 strong 授权用户可设置强约束。";
              } else {
                const result = await blockMgr.setLevel(key, label, level);
                text = result.ok ? `✅ 已设置 ${label} 为 ${level}` : `❌ ${result.error}`;
              }
              break;
            }
            case "idle":
              text = await cmdSetStatus(blockMgr, key, rest, "idle", "idle", "💤 已停用");
              break;
            case "activate":
              text = await cmdSetStatus(blockMgr, key, rest, "active", "activate", "🟢 已激活");
              break;
            case "pin":
              text = await cmdSetStatus(blockMgr, key, rest, "pinned", "pin", "🔒 已锚定");
              break;
            case "unpin":
              text = await cmdSetStatus(blockMgr, key, rest, "active", "unpin", "🟢 已取消锚定");
              break;
            case "clear":
              text = await cmdClear(blockMgr, key, rest);
              break;
            case "help":
              text = helpText();
              break;
            default:
              text = `未知子命令: ${subcommand}\n\n` + helpText();
          }
          // ReplyPayload 的文本字段是 text（没有 content 字段）
          return { text };
        } catch (e: any) {
          api.logger?.error?.(`[钉选上下文] 命令执行失败: ${e?.message ?? e}`);
          return { text: `操作失败: ${e?.message ?? e}` };
        }
      },
    });
  },
});

// ── 子命令实现 ────────────────────────────────────────

async function cmdAdd(mgr: BlockManager, sessionKey: string, rest: string, level: "strong" | "context"): Promise<string> {
  const { text: body, pinned } = extractPinnedFlag(rest);
  const match = /^(\S+)\s+([\s\S]+)$/u.exec(body);
  if (!match) {
    return "用法: /pin add <标签> <内容> [--pinned]";
  }
  const label = match[1];
  const content = match[2].trim();
  const status = pinned ? "pinned" : "active";
  const result = await mgr.add(sessionKey, label, content, status, level);
  return result.ok ? `✅ 已钉选: 【${label}】（${level} / ${status}）` : `❌ ${result.error}`;
}

function cmdList(mgr: BlockManager, sessionKey: string, tokenThreshold: number): string {
  const grouped = mgr.listAll(sessionKey);
  const total = grouped.active.length + grouped.idle.length + grouped.pinned.length;
  if (total === 0) {
    return "当前没有任何钉选块。使用 /pin add <标签> <内容> 创建。";
  }

  const lines: string[] = [`📌 钉选上下文块（共 ${total} 个）\n`];
  const icons: Record<string, string> = { active: "🟢", idle: "💤", pinned: "🔒" };

  for (const status of ["pinned", "active", "idle"] as const) {
    const blocks = grouped[status];
    if (!blocks || blocks.length === 0) continue;
    lines.push(`${icons[status]} ${status}（${blocks.length} 个）:`);
    for (const b of blocks) {
      const preview = b.content.length > 60 ? b.content.slice(0, 60) + "..." : b.content;
      lines.push(`  【${b.label}】[${b.level}] ${preview}`);
    }
    lines.push("");
  }

  // token 警告
  const activeCount = grouped.active.length + grouped.pinned.length;
  if (activeCount > 0 && tokenThreshold > 0) {
    const estChars = [...grouped.active, ...grouped.pinned].reduce(
      (sum, b) => sum + b.content.length + b.label.length + 25,
      0,
    );
    const estTokens = Math.floor(estChars * 1.5);
    if (estTokens > tokenThreshold) {
      lines.push(`⚠️ 估算注入 token: ~${estTokens}，建议停用不常用的块。`);
    }
  }

  return lines.join("\n");
}

async function cmdRemove(mgr: BlockManager, sessionKey: string, label: string): Promise<string> {
  if (!label) return "用法: /pin remove <标签>";
  const result = await mgr.remove(sessionKey, label);
  return result.ok ? `✅ 已删除: ${label}` : `❌ ${result.error}`;
}

async function cmdEdit(mgr: BlockManager, sessionKey: string, rest: string): Promise<string> {
  const match = /^(\S+)\s+([\s\S]+)$/u.exec(rest);
  if (!match) return "用法: /pin edit <标签> <新内容>";
  const label = match[1];
  const content = match[2];
  const result = await mgr.update(sessionKey, label, content);
  return result.ok ? `✅ 已更新: ${label}` : `❌ ${result.error}`;
}

async function cmdSetStatus(
  mgr: BlockManager,
  sessionKey: string,
  label: string,
  status: "active" | "idle" | "pinned",
  subcommand: string,
  successMsg: string,
): Promise<string> {
  if (!label) return `用法: /pin ${subcommand} <标签>`;
  const result = await mgr.setStatus(sessionKey, label, status);
  return result.ok ? `${successMsg}: ${label}` : `❌ ${result.error}`;
}

async function cmdClear(mgr: BlockManager, sessionKey: string, confirm: string): Promise<string> {
  const grouped = mgr.listAll(sessionKey);
  const total = grouped.active.length + grouped.idle.length + grouped.pinned.length;
  const pinnedCount = grouped.pinned.length;

  if (confirm.trim().toLowerCase() !== "confirm") {
    let hint = `⚠️ 将删除全部 ${total} 个钉选块`;
    if (pinnedCount > 0) hint += `（其中含 ${pinnedCount} 个 🔒 pinned 块）`;
    hint += "。输入 /pin clear confirm 确认。";
    return hint;
  }

  const count = await mgr.clear(sessionKey);
  return `✅ 已清空 ${count} 个钉选块。`;
}

function helpText(): string {
  return `📌 钉选上下文块 — 命令帮助

/pin add <标签> <内容>            新增块（默认 active）
/pin add <标签> <内容> --pinned   新增为长期锚定块
/pin add-strong <标签> <内容>      新增强约束
/pin add-context <标签> <内容>     新增参考上下文
/pin level <标签> strong|context  切换注入级别
/pin list                          列出所有块（按状态分组）
/pin remove <标签>                 删除块
/pin edit <标签> <新内容>          编辑块
/pin idle <标签>                   停用（→ 闲置，后续自动清理）
/pin activate <标签>               重新激活闲置块
/pin pin <标签>                    长期锚定（永不过期）
/pin unpin <标签>                  取消锚定
/pin clear                         清空全部（需二次确认）
/pin shared <子命令>              群共享块（仅配置的共享管理员可修改）

状态说明：
🟢 active  正常注入，不会被自动清理
💤 idle    不注入，闲置 7 天+10 轮或满 30 天后自动删除
🔒 pinned  长期锚定，永不过期，仅手动删除

会话范围：私聊默认生效。群聊需设置 enableInGroup: true；
频道和无法判定类型的会话始终禁用。`;
}
