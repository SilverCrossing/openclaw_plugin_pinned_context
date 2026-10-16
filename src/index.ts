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
  const name = chatType === "unknown" ? "unknown-type" : chatType === "group" ? "group" : "channel";
  return `❌ /pin is unavailable in this ${name} chat. The chat may be disabled, lack a trusted group or sender ID, or be outside the group allowlist.`;
}

// ── 插件入口 ──────────────────────────────────────────

export default definePluginEntry({
  id: "pinned-context",
  name: "Pinned Context Blocks",
  description: "User-managed strong and context blocks for direct and group chats",

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
        `[pinned-context] Session ${sessionKey} has chat type ${chatType}; ` +
          `fail-closed: injection was skipped. Check the channel session key.`,
      );
    };

    api.logger?.info?.("[pinned-context] Plugin initialized");

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
      description: "Manage pinned context blocks",
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
          return { text: "❌ Unable to identify this chat. Operation cancelled." };
        }

        const chatType = deriveChatType(sessionKey, ctx.channel);
        const scope = resolveScope({
          sessionKey, channel: ctx.channel, senderId: ctx.senderId,
        }, enableInGroup, groupWhitelist);
        if (!scope) return { text: rejectText(chatType) };
        if (scope.chatType === "direct" && !ctx.isAuthorizedSender) {
          return { text: "❌ Only authorized senders can manage blocks in direct chats." };
        }
        const parsed = parsePinArgs(ctx.args);
        const shared = parsed.subcommand === "shared";
        if (shared && !scope.sharedKey) return { text: "❌ /pin shared is available only in group chats." };
        const { subcommand, rest } = shared ? parsePinArgs(parsed.rest) : parsed;
        const key = shared ? scope.sharedKey! : scope.personalKey;
        const sender = ctx.senderId?.trim() ?? "";
        const canSharedWrite = senderAllowed(sharedAdmins, scope, sender);
        const canStrong = canSharedWrite || senderAllowed(strongUsers, scope, sender);
        if (shared && subcommand !== "list" && subcommand !== "help" && !canSharedWrite) {
          return { text: "❌ Only configured shared-block administrators can change shared blocks." };
        }
        if (scope.chatType === "group" && !shared && !canStrong && subcommand === "clear" &&
            Object.values(blockMgr.listAll(key)).flat().some((block) => block.level === "strong")) {
          return { text: "❌ This scope contains strong blocks. Only authorized users can clear it." };
        }
        if (scope.chatType === "group" && !shared && !canStrong &&
            ["edit", "remove", "idle", "activate", "pin", "unpin", "level"].includes(subcommand)) {
          const label = rest.split(/\s+/u)[0];
          const existing = Object.values(blockMgr.listAll(key)).flat().find((block) => block.label === label);
          if (existing?.level === "strong") return { text: "❌ Only authorized users can change this strong block." };
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
                text = "❌ Only users authorized for personal strong blocks can add one in a group.";
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
                text = "Usage: /pin level <label> strong|context";
              } else if (scope.chatType === "group" && !shared && level === "strong" && !canStrong) {
                text = "❌ Only users authorized for personal strong blocks can set this level in a group.";
              } else {
                const result = await blockMgr.setLevel(key, label, level);
                text = result.ok ? `✅ Set '${label}' to ${level}` : `❌ ${result.error}`;
              }
              break;
            }
            case "idle":
              text = await cmdSetStatus(blockMgr, key, rest, "idle", "idle", "💤 Deactivated");
              break;
            case "activate":
              text = await cmdSetStatus(blockMgr, key, rest, "active", "activate", "🟢 Activated");
              break;
            case "pin":
              text = await cmdSetStatus(blockMgr, key, rest, "pinned", "pin", "🔒 Pinned");
              break;
            case "unpin":
              text = await cmdSetStatus(blockMgr, key, rest, "active", "unpin", "🟢 Unpinned");
              break;
            case "clear":
              text = await cmdClear(blockMgr, key, rest);
              break;
            case "help":
              text = helpText();
              break;
            default:
              text = `Unknown subcommand: ${subcommand}\n\n` + helpText();
          }
          // ReplyPayload 的文本字段是 text（没有 content 字段）
          return { text };
        } catch (e: any) {
          api.logger?.error?.(`[pinned-context] Command failed: ${e?.message ?? e}`);
          return { text: `Operation failed: ${e?.message ?? e}` };
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
    return "Usage: /pin add <label> <content> [--pinned]";
  }
  const label = match[1];
  const content = match[2].trim();
  const status = pinned ? "pinned" : "active";
  const result = await mgr.add(sessionKey, label, content, status, level);
  return result.ok ? `✅ Added '${label}' (${level} / ${status})` : `❌ ${result.error}`;
}

function cmdList(mgr: BlockManager, sessionKey: string, tokenThreshold: number): string {
  const grouped = mgr.listAll(sessionKey);
  const total = grouped.active.length + grouped.idle.length + grouped.pinned.length;
  if (total === 0) {
    return "No pinned context blocks yet. Use /pin add <label> <content> to create one.";
  }

  const lines: string[] = [`📌 Pinned context blocks (${total} total)\n`];
  const icons: Record<string, string> = { active: "🟢", idle: "💤", pinned: "🔒" };

  for (const status of ["pinned", "active", "idle"] as const) {
    const blocks = grouped[status];
    if (!blocks || blocks.length === 0) continue;
    lines.push(`${icons[status]} ${status} (${blocks.length}):`);
    for (const b of blocks) {
      const preview = b.content.length > 60 ? b.content.slice(0, 60) + "..." : b.content;
      lines.push(`  [${b.label}] [${b.level}] ${preview}`);
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
      lines.push(`⚠️ Estimated injected tokens: ~${estTokens}. Consider deactivating unused blocks.`);
    }
  }

  return lines.join("\n");
}

async function cmdRemove(mgr: BlockManager, sessionKey: string, label: string): Promise<string> {
  if (!label) return "Usage: /pin remove <label>";
  const result = await mgr.remove(sessionKey, label);
  return result.ok ? `✅ Removed: ${label}` : `❌ ${result.error}`;
}

async function cmdEdit(mgr: BlockManager, sessionKey: string, rest: string): Promise<string> {
  const match = /^(\S+)\s+([\s\S]+)$/u.exec(rest);
  if (!match) return "Usage: /pin edit <label> <new content>";
  const label = match[1];
  const content = match[2];
  const result = await mgr.update(sessionKey, label, content);
  return result.ok ? `✅ Updated: ${label}` : `❌ ${result.error}`;
}

async function cmdSetStatus(
  mgr: BlockManager,
  sessionKey: string,
  label: string,
  status: "active" | "idle" | "pinned",
  subcommand: string,
  successMsg: string,
): Promise<string> {
  if (!label) return `Usage: /pin ${subcommand} <label>`;
  const result = await mgr.setStatus(sessionKey, label, status);
  return result.ok ? `${successMsg}: ${label}` : `❌ ${result.error}`;
}

async function cmdClear(mgr: BlockManager, sessionKey: string, confirm: string): Promise<string> {
  const grouped = mgr.listAll(sessionKey);
  const total = grouped.active.length + grouped.idle.length + grouped.pinned.length;
  const pinnedCount = grouped.pinned.length;

  if (confirm.trim().toLowerCase() !== "confirm") {
    let hint = `⚠️ This will remove all ${total} block${total === 1 ? "" : "s"}`;
    if (pinnedCount > 0) hint += `, including ${pinnedCount} 🔒 pinned block${pinnedCount === 1 ? "" : "s"}`;
    hint += ". Enter /pin clear confirm to proceed.";
    return hint;
  }

  const count = await mgr.clear(sessionKey);
  return `✅ Cleared ${count} block${count === 1 ? "" : "s"}.`;
}

function helpText(): string {
  return `📌 Pinned Context Blocks — command help

/pin add <label> <content>                 Add a block (active by default)
/pin add <label> <content> --pinned        Add a block retained until manual removal
/pin add <label> -- <literal content>      Preserve a trailing --pinned as content
/pin add-strong <label> <content>          Add a strong constraint
/pin add-context <label> <content>         Add reference context
/pin level <label> strong|context          Change the injection level
/pin list                                  List blocks by state
/pin remove <label>                        Remove a block
/pin edit <label> <new content>            Edit a block
/pin idle <label>                          Deactivate a block for later cleanup
/pin activate <label>                      Reactivate an idle block
/pin pin <label>                           Retain a block until manual removal
/pin unpin <label>                         Return a pinned block to active
/pin clear                                 Clear all blocks (confirmation required)
/pin shared <subcommand>                   Group shared blocks (only configured administrators may change them)
/pin help                                  Show this help

States:
🟢 active  Injected normally; never removed automatically
💤 idle    Not injected; removed after 7 days and 10 calls, or after 30 days
🔒 pinned  Retained indefinitely; only removed manually

Scope: Direct chats are enabled by default. Group chats require enableInGroup: true.
Channel chats and chats of unknown type are always disabled.`;
}
