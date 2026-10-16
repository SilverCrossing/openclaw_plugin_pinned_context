import { deriveChatType, type ChatType } from "./chat_type.js";

export interface PinIdentity {
  sessionKey?: string;
  channel?: string;
  senderId?: string;
  chatId?: string;
}

export interface PinScope {
  chatType: ChatType;
  personalKey: string;
  sharedKey?: string;
  groupId?: string;
}

/** Use the routed group key, omitting only OpenClaw's per-sender suffix. */
export function resolveScope(identity: PinIdentity, enableInGroup: boolean, whitelist: string[]): PinScope | null {
  const sessionKey = identity.sessionKey?.trim();
  if (!sessionKey) return null;
  const chatType = deriveChatType(sessionKey, identity.channel);
  if (chatType === "direct") return { chatType, personalKey: sessionKey };
  if (chatType !== "group" || !enableInGroup) return null;
  const senderId = identity.senderId?.trim();
  if (!senderId) return null;
  const match = /(?:^|:)group:([^:]+)/iu.exec(sessionKey);
  const groupId = match?.[1];
  if (!groupId) return null;
  const rawGroupId = sessionKey.slice(match.index + match[0].length - groupId.length);
  // OpenClaw may add topic and sender suffixes to a group session key. A group
  // block belongs to the group itself, independent of those per-message routes.
  const baseKey = sessionKey.slice(0, match.index + match[0].length);
  // The prompt hook may expose either the native parent chat id or the full
  // session peer id (including :topic: / :sender: suffixes) as chatId.
  if (identity.chatId && identity.chatId !== groupId && identity.chatId !== rawGroupId) return null;
  if (whitelist.length > 0 && !whitelist.includes(groupId) && !whitelist.includes(baseKey)) return null;
  return {
    chatType,
    groupId,
    personalKey: `personal:${baseKey}:u:${senderId}`,
    sharedKey: `shared:${baseKey}`,
  };
}

export function senderAllowed(entries: string[], scope: PinScope, senderId: string): boolean {
  return entries.includes(senderId) ||
    (scope.sharedKey !== undefined && entries.includes(`${scope.sharedKey.slice(7)}::u:${senderId}`));
}
