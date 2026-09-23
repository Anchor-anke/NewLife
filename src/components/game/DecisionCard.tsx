'use client';

import { useState } from 'react';
import { Badge, Button, Panel, TextArea } from '@/components/ui';
import { DECISION_CAUSE_LABELS } from '@/lib/engine/decision';
import type { DecisionPoint, JevScores } from '@/lib/engine/types';

/**
 * 决策卡：插在年表末尾的岔路。
 *
 * 这是整个重构里**唯一**会打断玩家的东西，因此它必须值得被打断——
 * 卡片上除了选项，还要写清「为什么这是个重要节点」（`stakes`），
 * 否则玩家会以为这又是一次日常取舍。
 *
 * 卡片上的 AI 只有一层：Jev 的被动推演（概率条）。它只给「这个角色会怎么走」
 * 的参考分布，不替玩家选、不写理由——决定永远是玩家自己做的。
 * 自由输入刻意保留在这里：岔路口正是最该让玩家自己写点什么的地方。
 */

/**
 * 置信度的展示语义。
 *
 * 真实岔路上 Jev 的置信度普遍落在 0.3~0.5（「人事」问题的分布本来就散，
 * 这是模型诚实的表现），若按数值藏概率条，整个功能会被藏掉大半。所以：
 * **只要分数到了就画条**，不确定性用文字表达——低置信时明确标注「仅供参考」，
 * 让玩家自己掂量这份分布值多少参考权重。
 */
const CONFIDENCE_HONEST_FLOOR = 0.5;

export function DecisionCard({
  decision,
  age,
  disabled,
  scores,
  onDecide,
}: {
  decision: DecisionPoint;
  /** 走到这个岔路时的年龄 */
  age: number;
  disabled: boolean;
  /** Jev 对各选项的被动推演。null/undefined 时完全不显示这一层。 */
  scores?: JevScores | null;
  onDecide: (action: string) => void;
}) {
  const [freeAction, setFreeAction] = useState('');
  const busy = disabled;

  const scoresUsable =
    scores !== null &&
    scores !== undefined &&
    scores.probabilities.length === decision.options.length;
  const confidenceHonest = scoresUsable && scores.confidence >= CONFIDENCE_HONEST_FLOOR;

  return (
    <Panel
      className="border-gold-500/50"
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span aria-hidden>⚑</span>
          {age} 岁 · 这是个岔路
          <Badge tone="gold">{DECISION_CAUSE_LABELS[decision.cause]}</Badge>
        </span>
      }
    >
      <div className="space-y-4">
        <p className="prose-narrative text-ink-200">{decision.prompt}</p>
        <p className="text-sm leading-relaxed text-ink-400">{decision.stakes}</p>

        <div className="grid gap-2">
          {scoresUsable && (
            <div className="flex items-center justify-between text-xs text-ink-500">
              <span>推演 · 这个角色会怎么走</span>
              <span>
                {confidenceHonest
                  ? `置信 ${Math.round(scores.confidence * 100)}%`
                  : `置信 ${Math.round(scores.confidence * 100)}% · 仅供参考`}
              </span>
            </div>
          )}
          {decision.options.map((option, index) => {
            const rawProbability = scoresUsable ? scores.probabilities[index] : undefined;
            const percent =
              rawProbability !== undefined ? Math.round(rawProbability * 100) : null;
            const isTop = scoresUsable && scores.topIndex === index;
            return (
              <button
                key={option}
                type="button"
                // 端到端脚本按这个属性点选项。选项文案来自模型、会变，
                // 用它当定位器等于把测试绑在模拟服务的措辞上。
                data-decision-option={index}
                disabled={busy}
                onClick={() => onDecide(option)}
                className={`cursor-pointer rounded-md border px-4 py-3 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  'border-ink-700 bg-ink-900 text-ink-200 hover:border-jade-500/50 hover:bg-ink-800'
                }`}
              >
                {option}
                {percent !== null && (
                  <span className="mt-2 flex items-center gap-2">
                    <span aria-hidden className="h-1 flex-1 overflow-hidden rounded-full bg-ink-800">
                      <span
                        aria-hidden
                        className={`block h-full rounded-full transition-[width] duration-500 ${
                          isTop ? 'bg-jade-400' : 'bg-ink-500'
                        }`}
                        style={{ width: `${percent}%` }}
                      />
                    </span>
                    <span
                      className={`w-10 text-right text-xs tabular-nums ${
                        isTop ? 'text-jade-300' : 'text-ink-500'
                      }`}
                    >
                      {percent}%
                    </span>
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="space-y-2 border-t border-ink-800 pt-4">
          <label htmlFor="free-action" className="block text-sm text-ink-300">
            或者，自己写一个决定
          </label>
          <TextArea
            id="free-action"
            rows={3}
            value={freeAction}
            onChange={(event) => setFreeAction(event.target.value)}
            placeholder="例如：我决定拜入青冥山，从最底层的杂役做起。"
            maxLength={300}
            disabled={busy}
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-ink-500">{freeAction.length} / 300</span>
            <Button
              variant="primary"
              disabled={busy || freeAction.trim() === ''}
              onClick={() => {
                const action = freeAction.trim();
                if (action === '') return;
                setFreeAction('');
                onDecide(action);
              }}
            >
              就按这个来
            </Button>
          </div>
        </div>
      </div>
    </Panel>
  );
}
