import type { ModelAdapter } from '@/lib/model/adapter';
import {
  buildEpilogueSystemPrompt,
  buildEpilogueUserMessage,
  buildSummarySystemPrompt,
  buildSummaryUserMessage,
} from './context';
import type {
  CharacterState,
  Ending,
  LifeSegmentRecord,
  SaveStats,
  WorldSetting,
} from './types';

/**
 * 长期摘要与人生总结的生成。
 *
 * 两者都是**无副作用**的模型调用：调用方拿到结果后再决定要不要落盘。
 * 这样设计是为了让摘要失败可以完全不影响已经结算完成的段落——
 * 失败了什么都不写，下一段或玩家手动重试即可。
 */

export interface SummarizeInput {
  world: WorldSetting;
  adapter: ModelAdapter;
  previousSummary: string;
  /** 需要并入摘要的新段落，按 segmentId 升序 */
  segments: readonly LifeSegmentRecord[];
  character: CharacterState;
  signal?: AbortSignal;
}

export interface GenerateEpilogueInput {
  world: WorldSetting;
  adapter: ModelAdapter;
  character: CharacterState;
  historySummary: string;
  segments: readonly LifeSegmentRecord[];
  ending: Ending;
  stats: SaveStats;
  signal?: AbortSignal;
}

/** 摘要长度上限。模型偶尔会写超，超出部分截断而不是让上下文无限膨胀。 */
const SUMMARY_MAX_LENGTH = 1200;

export async function summarizeHistory(
  input: SummarizeInput,
): Promise<{ summary: string; latencyMs: number }> {
  const { text, latencyMs } = await input.adapter.complete(
    {
      messages: [
        { role: 'system', content: buildSummarySystemPrompt(input.world) },
        {
          role: 'user',
          content: buildSummaryUserMessage({
            world: input.world,
            previousSummary: input.previousSummary,
            segments: [...input.segments],
            character: input.character,
          }),
        },
      ],
      temperature: 0.3,
    },
    input.signal ? { signal: input.signal } : {},
  );

  const summary = text.trim().slice(0, SUMMARY_MAX_LENGTH);
  return { summary, latencyMs };
}

export async function generateEpilogue(
  input: GenerateEpilogueInput,
): Promise<{ epilogue: string; latencyMs: number }> {
  const { text, latencyMs } = await input.adapter.complete(
    {
      messages: [
        { role: 'system', content: buildEpilogueSystemPrompt(input.world) },
        {
          role: 'user',
          content: buildEpilogueUserMessage({
            world: input.world,
            character: input.character,
            historySummary: input.historySummary,
            segments: [...input.segments],
            ending: input.ending,
            stats: input.stats,
          }),
        },
      ],
      temperature: 0.75,
    },
    input.signal ? { signal: input.signal } : {},
  );

  return { epilogue: text.trim(), latencyMs };
}
