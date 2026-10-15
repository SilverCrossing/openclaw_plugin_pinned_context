/**
 * 会话类型推导 —— 从会话键（sessionKey）判断私聊 / 群聊 / 频道。
 *
 * OpenClaw core 有等价实现 `deriveSessionChatType`（src/sessions/session-chat-type.ts），
 * 但它没有通过任何 plugin-sdk 子路径导出（session-key-runtime 只导出
 * isIncognitoSessionKey 与 resolveAgentIdFromSessionKey），插件无法直接引用，
 * 因此这里按其判定规则实现本地副本。规则来源：
 *   - src/sessions/session-chat-type-shared.ts（parseCanonicalSessionPeerShape / 遗留形）
 *   - src/sessions/session-chat-type.ts（agent 包装剥离）
 *
 * 安全相关：本模块的返回值直接决定是否把内容注入 system prompt，
 * 判定不确定时返回 "unknown"，由调用方按 fail-closed 处理。
 */

export type ChatType = "direct" | "group" | "channel" | "unknown";

/** 规范形中合法的 peer kind（core: CANONICAL_PEER_KINDS） */
const CANONICAL_PEER_KINDS: ReadonlySet<string> = new Set(["direct", "dm", "group", "channel"]);

/**
 * 浏览器私聊界面的频道标识。
 *
 * 这类界面的会话键一般不含 peer kind，只靠会话键会落到 "unknown"，
 * 进而在 fail-closed 策略下被误杀。core 的 active-memory 插件
 * （extensions/active-memory/session-policy.ts）同样把 webchat 归一为 direct。
 */
const DIRECT_ONLY_CHANNELS: ReadonlySet<string> = new Set(["webchat", "webui"]);

/** 剥离 `agent:<agentId>:` 包装（core: parseAgentSessionKey） */
function stripAgentScope(sessionKey: string): string {
  const parts = sessionKey.split(":");
  if (parts[0] !== "agent" || parts.length < 3) return sessionKey;
  return parts.slice(2).join(":");
}

/** dm 归一为 direct（core: normalizeChatType） */
function normalizePeerKind(kind: string): ChatType {
  if (kind === "dm") return "direct";
  return kind === "direct" || kind === "group" || kind === "channel" ? kind : "unknown";
}

/**
 * 规范形（core: parseCanonicalSessionPeerShape）：
 *   direct:<peerId> | dm:<peerId>
 *   <channel>:<peerKind>:<peerId>
 *   <channel>:<account>:<peerKind>:<peerId>
 */
function parseCanonicalPeerKind(scoped: string): ChatType | undefined {
  const parts = scoped.split(":");
  if ((parts[0] === "direct" || parts[0] === "dm") && parts[1]) {
    return "direct";
  }
  if (parts[0] && CANONICAL_PEER_KINDS.has(parts[1] ?? "") && parts[2]) {
    return normalizePeerKind(parts[1] as string);
  }
  if (parts[0] && parts[1] && CANONICAL_PEER_KINDS.has(parts[2] ?? "") && parts[3]) {
    return normalizePeerKind(parts[2] as string);
  }
  return undefined;
}

/** 遗留形（core: deriveBuiltInLegacySessionChatType） */
function parseLegacyChatType(scoped: string): ChatType | undefined {
  if (/^group:[^:]+(?::.*)?$/u.test(scoped)) return "group";
  if (/^channel:[^:]+(?::.*)?$/u.test(scoped)) return "channel";
  if (/^(?:whatsapp:)?[^:]+@g\.us$/u.test(scoped)) return "group";
  if (/^discord:(?:[^:]+:)?guild-[^:]+:channel-[^:]+$/u.test(scoped)) return "channel";
  return undefined;
}

/**
 * 推导会话类型。
 *
 * @param sessionKey 会话键（ctx.sessionKey）
 * @param channel    频道标识（ctx.channel）；仅当会话键无法判定时用于兜底
 */
export function deriveChatType(
  sessionKey: string | undefined | null,
  channel?: string | null,
): ChatType {
  const raw = typeof sessionKey === "string" ? sessionKey.trim().toLowerCase() : "";
  if (!raw) return "unknown";

  const scoped = stripAgentScope(raw);

  const canonical = parseCanonicalPeerKind(scoped);
  if (canonical) return canonical;

  const legacy = parseLegacyChatType(scoped);
  if (legacy) return legacy;

  const channelId = typeof channel === "string" ? channel.trim().toLowerCase() : "";
  if (DIRECT_ONLY_CHANNELS.has(channelId)) return "direct";

  return "unknown";
}

/**
 * 是否允许在该会话注入 / 操作钉选块。
 *
 * fail-closed：channel / unknown 一律拒绝，group 仅在 enableInGroup 显式开启时放行。
 * unknown 阻断而非放行，是因为本插件可能往 system prompt 注入内容，
 * 判定不明时应当拒绝——原实现反其道而行（恒判定为私聊），正是漏洞所在。
 */
export function shouldAllowSession(chatType: ChatType, enableInGroup: boolean): boolean {
  return chatType === "direct" || (enableInGroup && chatType === "group");
}
