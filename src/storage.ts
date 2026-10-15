/**
 * JSON 文件持久化 —— 钉选块的存储层。
 *
 * 按 sessionId 分组存储，每次读写都加载/保存整个文件。
 * 对于插件场景（块数量少、并发低）足够用。
 */
import * as fs from "fs";
import * as path from "path";

/** 钉选块数据结构 */
export interface PinnedBlock {
  id: number;
  sessionId: string;
  label: string;
  content: string;
  status: "active" | "idle" | "pinned";
  level: "strong" | "context";
  idleSince: string | null;
  llmCallCount: number;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

/** 存储格式：按 sessionId 分组 */
type StorageData = Record<string, PinnedBlock[]>;

export class Storage {
  private filePath: string;
  private data: StorageData = {};
  private nextId: number = 1;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    // 确保数据目录存在
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.filePath = path.join(dataDir, "pinned_blocks.json");
    this.load();
  }

  /** 从磁盘加载数据 */
  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Invalid pinned block store");
        }
        this.data = parsed as StorageData;
        // 计算 nextId
        let maxId = 0;
        for (const blocks of Object.values(this.data)) {
          if (!Array.isArray(blocks)) throw new Error("Invalid pinned block list");
          for (const b of blocks) {
            // Existing direct-chat blocks were system-level in the previous version.
            if (b.level !== "strong" && b.level !== "context") b.level = "strong";
            if (b.id > maxId) maxId = b.id;
          }
        }
        this.nextId = maxId + 1;
      }
    } catch (error) {
      // Refuse to start against damaged data instead of overwriting it on the next write.
      throw new Error(`Unable to load pinned blocks from ${this.filePath}`, { cause: error });
    }
  }

  /** 保存到磁盘（串行化写入避免并发问题） */
  private save(): Promise<void> {
    this.writeQueue = this.writeQueue.catch(() => {}).then(() => {
      const raw = JSON.stringify(this.data, null, 2);
      const temporary = `${this.filePath}.tmp`;
      fs.writeFileSync(temporary, raw, "utf-8");
      fs.renameSync(temporary, this.filePath);
    });
    return this.writeQueue;
  }

  /** 获取会话的所有块 */
  getBlocks(sessionId: string): PinnedBlock[] {
    return this.data[sessionId] ?? [];
  }

  /** 获取单个块 by label */
  getBlock(sessionId: string, label: string): PinnedBlock | undefined {
    return this.getBlocks(sessionId).find((b) => b.label === label);
  }

  /** 新增块，返回新块（含分配的 id） */
  async addBlock(block: Omit<PinnedBlock, "id">): Promise<PinnedBlock> {
    if (!this.data[block.sessionId]) {
      this.data[block.sessionId] = [];
    }
    const newBlock: PinnedBlock = { ...block, id: this.nextId++ };
    this.data[block.sessionId].push(newBlock);
    await this.save();
    return newBlock;
  }

  /** 更新块（通过 sessionId + label 定位） */
  async updateBlock(
    sessionId: string,
    label: string,
    updates: Partial<PickedBlock>,
  ): Promise<PinnedBlock | null> {
    const blocks = this.data[sessionId];
    if (!blocks) return null;
    const block = blocks.find((b) => b.label === label);
    if (!block) return null;
    Object.assign(block, updates);
    await this.save();
    return block;
  }

  /** 删除块，返回是否删除成功 */
  async removeBlock(sessionId: string, label: string): Promise<boolean> {
    const blocks = this.data[sessionId];
    if (!blocks) return false;
    const idx = blocks.findIndex((b) => b.label === label);
    if (idx === -1) return false;
    blocks.splice(idx, 1);
    if (blocks.length === 0) delete this.data[sessionId];
    await this.save();
    return true;
  }

  /** 删除满足条件的块（用于 idle 清理） */
  async purgeBlocks(sessionId: string, predicate: (b: PinnedBlock) => boolean): Promise<number> {
    const blocks = this.data[sessionId];
    if (!blocks) return 0;
    const before = blocks.length;
    this.data[sessionId] = blocks.filter((b) => !predicate(b));
    const purged = before - this.data[sessionId].length;
    if (this.data[sessionId].length === 0) delete this.data[sessionId];
    if (purged > 0) await this.save();
    return purged;
  }

  /** 清空会话的所有块 */
  async clearBlocks(sessionId: string): Promise<number> {
    const blocks = this.data[sessionId];
    if (!blocks) return 0;
    const count = blocks.length;
    delete this.data[sessionId];
    await this.save();
    return count;
  }

  /** 获取会话的块数量 */
  countBlocks(sessionId: string): number {
    return this.getBlocks(sessionId).length;
  }

  /** 递增会话内所有 idle 块的 llmCallCount */
  async incrementIdleCallCount(sessionId: string): Promise<void> {
    const blocks = this.data[sessionId];
    if (!blocks) return;
    let changed = false;
    for (const b of blocks) {
      if (b.status === "idle") {
        b.llmCallCount++;
        changed = true;
      }
    }
    if (changed) await this.save();
  }
}

/** Partial<PinnedBlock> 的别名，但排除 id 和 sessionId */
type PickedBlock = Omit<Partial<PinnedBlock>, "id" | "sessionId">;
