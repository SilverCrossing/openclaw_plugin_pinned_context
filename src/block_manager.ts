/**
 * 钉选块的 CRUD、状态管理、闲置清理。
 *
 * 从 AstrBot 版（Python）移植到 TypeScript，核心逻辑保持一致。
 */
import { Storage, PinnedBlock } from "./storage.js";

const VALID_STATUS = ["active", "idle", "pinned"] as const;
type BlockStatus = (typeof VALID_STATUS)[number];

export interface BlockConfig {
  maxBlocks: number;
  maxLabelLen: number;
  maxContentLen: number;
  idleRetentionDays: number;
  idleRetentionCalls: number;
  idleHardRetentionDays: number;
}

export class BlockManager {
  private storage: Storage;
  private config: BlockConfig;

  constructor(storage: Storage, config: BlockConfig) {
    this.storage = storage;
    this.config = config;
  }

  // ── 核心 CRUD ──────────────────────────────────────

  async add(
    sessionId: string,
    label: string,
    content: string,
    status: BlockStatus = "active",
    level: "strong" | "context" = "strong",
  ): Promise<{ ok: boolean; error?: string; label?: string; status?: string }> {
    if (!VALID_STATUS.includes(status)) {
      return { ok: false, error: `无效状态: ${status}` };
    }

    label = label.trim().slice(0, this.config.maxLabelLen);
    content = content.trim().slice(0, this.config.maxContentLen);

    if (!label || !content) {
      return { ok: false, error: "标签和内容不能为空" };
    }

    // 检查数量上限
    const count = this.storage.countBlocks(sessionId);
    if (count >= this.config.maxBlocks) {
      return { ok: false, error: `已达上限（${this.config.maxBlocks} 个块），请先清理` };
    }

    // 检查标签是否已存在
    if (this.storage.getBlock(sessionId, label)) {
      return { ok: false, error: `标签'${label}'已存在，使用 /pin edit 修改或 /pin remove 删除` };
    }

    const now = new Date().toISOString();
    await this.storage.addBlock({
      sessionId,
      label,
      content,
      status,
      level,
      idleSince: null,
      llmCallCount: 0,
      priority: 0,
      createdAt: now,
      updatedAt: now,
    });

    return { ok: true, label, status };
  }

  async remove(sessionId: string, label: string): Promise<{ ok: boolean; error?: string }> {
    const deleted = await this.storage.removeBlock(sessionId, label);
    return deleted ? { ok: true } : { ok: false, error: `块'${label}'不存在` };
  }

  async update(
    sessionId: string,
    label: string,
    content: string,
  ): Promise<{ ok: boolean; error?: string }> {
    content = content.trim().slice(0, this.config.maxContentLen);
    if (!content) {
      return { ok: false, error: "内容不能为空" };
    }

    const now = new Date().toISOString();
    const updated = await this.storage.updateBlock(sessionId, label, { content, updatedAt: now });
    return updated ? { ok: true } : { ok: false, error: `块'${label}'不存在` };
  }

  // ── 状态管理 ────────────────────────────────────────

  async setStatus(
    sessionId: string,
    label: string,
    newStatus: BlockStatus,
  ): Promise<{ ok: boolean; error?: string; status?: string }> {
    if (!VALID_STATUS.includes(newStatus)) {
      return { ok: false, error: `无效状态: ${newStatus}` };
    }

    const now = new Date().toISOString();
    const updates: Partial<PinnedBlock> = {
      status: newStatus,
      llmCallCount: 0, // 重置计数器
      updatedAt: now,
    };

    if (newStatus === "idle") {
      updates.idleSince = now;
    } else {
      updates.idleSince = null;
    }

    const updated = await this.storage.updateBlock(sessionId, label, updates);
    return updated ? { ok: true, status: newStatus } : { ok: false, error: `块'${label}'不存在` };
  }

  async setLevel(sessionId: string, label: string, level: "strong" | "context") {
    const updated = await this.storage.updateBlock(sessionId, label, {
      level,
      updatedAt: new Date().toISOString(),
    });
    return updated ? { ok: true } : { ok: false, error: `块'${label}'不存在` };
  }

  // ── 查询 ────────────────────────────────────────────

  listAll(sessionId: string): Record<string, PinnedBlock[]> {
    const blocks = this.storage.getBlocks(sessionId);
    const grouped: Record<string, PinnedBlock[]> = { active: [], idle: [], pinned: [] };
    for (const b of blocks) {
      grouped[b.status]?.push(b);
    }
    return grouped;
  }

  getActive(sessionId: string): PinnedBlock[] {
    const blocks = this.storage.getBlocks(sessionId);
    return blocks
      .filter((b) => b.status === "active" || b.status === "pinned")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  count(sessionId: string): number {
    return this.storage.countBlocks(sessionId);
  }

  // ── 闲置清理 ────────────────────────────────────────

  async incrementCallCount(sessionId: string): Promise<void> {
    await this.storage.incrementIdleCallCount(sessionId);
  }

  async purgeStaleIdle(sessionId: string): Promise<number> {
    const cutoff = new Date(Date.now() - this.config.idleRetentionDays * 24 * 60 * 60 * 1000).toISOString();
    const hardCutoff = new Date(Date.now() - this.config.idleHardRetentionDays * 24 * 60 * 60 * 1000).toISOString();
    return this.storage.purgeBlocks(
      sessionId,
      (b) =>
        b.status === "idle" &&
        b.idleSince !== null &&
        (b.idleSince <= hardCutoff ||
          (b.idleSince <= cutoff && b.llmCallCount >= this.config.idleRetentionCalls)),
    );
  }

  async clear(sessionId: string): Promise<number> {
    return this.storage.clearBlocks(sessionId);
  }
}
