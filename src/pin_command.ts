/**
 * /pin 命令的参数解析。
 *
 * 命令注册时声明了 `acceptsArgs: true`，因此 `ctx.args` 只包含命令名之后的参数，
 * 不再需要像旧实现那样手工剥离 "pin " 前缀
 * （旧实现用 `raw.toLowerCase().startsWith("pin ")` 猜测，属于对错误 API 的补偿）。
 *
 * 注：若未声明 acceptsArgs，带参数的调用会被判定为 non-plugin 命令并静默漏过
 * （core: src/plugins/plugin-command-runtime.ts）。
 */

export interface ParsedPinArgs {
  /** 子命令，已归一为小写；无参数时为空串 */
  subcommand: string;
  /** 子命令之后的全部参数 */
  rest: string;
}

/** 解析 `ctx.args` → 子命令 + 剩余参数 */
export function parsePinArgs(args?: string | null): ParsedPinArgs {
  const input = (typeof args === "string" ? args : "").trim();
  const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(input);
  return {
    subcommand: (match?.[1] ?? "").toLowerCase(),
    rest: match?.[2]?.trim() ?? "",
  };
}

/** 提取尾部的 `--pinned` 标记（大小写不敏感） */
export function extractPinnedFlag(rest: string): { text: string; pinned: boolean } {
  if (/^\S+\s+--(?:\s|$)/u.test(rest)) {
    return { text: rest.replace(/^(\S+)\s+--\s*/u, "$1 ").trim(), pinned: false };
  }
  const match = /(?:^|\s)--pinned\s*$/iu.exec(rest);
  if (!match) return { text: rest.trim(), pinned: false };
  return { text: rest.slice(0, match.index).trim(), pinned: true };
}
