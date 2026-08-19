import type { Attempt, LearnerState, Mastery } from './schema.js';
import { LearnerStateSchema } from './schema.js';
import { emptyLearner, record } from './mastery.js';

/**
 * 学习记录怎么存。
 *
 * 抽成接口是因为这份数据的性质和画布不一样：画布可以丢（重画一张就是了），
 * 学习记录丢了就真的没了——"我哪些会哪些不会"是攒了几个月的东西。
 * 所以持久化那层单独拎出来，测试里塞内存实现，线上塞落盘实现。
 */
export interface LearnerStore {
  get(learnerId: string): Promise<LearnerState>;
  save(state: LearnerState): Promise<void>;
  list(): Promise<string[]>;
}

export class MemoryLearnerStore implements LearnerStore {
  private readonly map = new Map<string, LearnerState>();

  async get(learnerId: string): Promise<LearnerState> {
    return this.map.get(learnerId) ?? emptyLearner(learnerId);
  }

  async save(state: LearnerState): Promise<void> {
    this.map.set(state.learnerId, state);
  }

  async list(): Promise<string[]> {
    return [...this.map.keys()];
  }
}

/**
 * 记一批练习并落盘。
 *
 * 放在这里而不是各调用点各写一遍：读-改-写这三步之间不能插进另一次写，
 * 否则同时结束两次辅导会丢掉其中一次的记录。
 */
export async function recordAttempts(
  store: LearnerStore,
  learnerId: string,
  attempts: Attempt[],
): Promise<Mastery[]> {
  const state = await store.get(learnerId);
  const out = attempts.map((a) => record(state, a));
  await store.save(state);
  return out;
}

/** 从磁盘上读回来时用，坏文件不能把整个服务带下去 */
export function parseLearner(raw: unknown, learnerId: string): LearnerState {
  const parsed = LearnerStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : emptyLearner(learnerId);
}
