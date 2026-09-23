'use client';

import { useEffect, useRef, useState } from 'react';
import type { JevScores } from '@/lib/engine/types';
import { patchSegmentJevScores } from '@/lib/storage/saves';
import { createJevClient } from './client';
import { isJevConfigured, loadJevApiKey, loadJevSettings, toJevConfig } from './settings';
import { buildJevScoreRequest, type JevStateInput } from './state';

/**
 * 决策卡的被动打分。
 *
 * 触发由 `decisionKey` 独占：一个岔路只发一次请求。**input 刻意不进依赖**——
 * 它由存档数据派生，存档任何一次落库都会让派生数组换新身份，把 input 放进
 * 依赖等于每次结算后重发一遍打分。最新值经 ref 传入 effect。
 *
 * 降级铁律：推演是锦上添花，任何失败（未配置、断网、5xx）都不打扰决策，
 * 界面上只是没有这一层。成功时把分数补写进段记录（`jevScores`），作为
 * 「分数 vs 玩家实际选择」的观测数据——落库失败同样不出声。
 */

export type JevScoreStatus = 'idle' | 'unconfigured' | 'loading' | 'ready' | 'error';

export function useJevScores(
  input: JevStateInput | null,
  decisionKey: string | null,
): { scores: JevScores | null; status: JevScoreStatus } {
  const [scores, setScores] = useState<JevScores | null>(null);
  const [status, setStatus] = useState<JevScoreStatus>('idle');

  const inputRef = useRef(input);
  inputRef.current = input;

  useEffect(() => {
    const current = inputRef.current;
    if (decisionKey === null || current === null) {
      setScores(null);
      setStatus('idle');
      return;
    }

    const settings = loadJevSettings();
    const apiKey = loadJevApiKey();
    if (!isJevConfigured(settings, apiKey)) {
      setScores(null);
      setStatus('unconfigured');
      return;
    }

    const parsed = parseDecisionKey(decisionKey);
    const client = createJevClient(toJevConfig(settings, apiKey));
    const controller = new AbortController();
    let cancelled = false;
    setStatus('loading');

    client
      .score(buildJevScoreRequest(current), { signal: controller.signal })
      .then((result) => {
        if (cancelled) return;
        const next: JevScores = {
          probabilities: result.scores.map((entry) => entry.probability),
          topIndex: result.topIndex,
          confidence: result.confidence,
          model: result.model,
        };
        setScores(next);
        setStatus('ready');
        if (parsed) {
          void patchSegmentJevScores(parsed.saveId, parsed.segmentId, next).catch(
            (cause: unknown) => {
              console.warn('[jev] 分数落库失败：', cause instanceof Error ? cause.message : cause);
            },
          );
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // 玩家先点了选项会走到这里（aborted）——这是正常路径，不该出声。
        // 其余失败在控制台留一行，便于排查配置问题。
        const aborted = cause instanceof DOMException && cause.name === 'AbortError';
        if (!aborted) {
          console.warn('[jev] 推演失败：', cause instanceof Error ? cause.message : cause);
        }
        setScores(null);
        setStatus(aborted ? 'idle' : 'error');
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [decisionKey]);

  return { scores, status };
}

/** decisionKey 的格式见 PlayClient；解析失败只意味着丢一条观测数据。 */
function parseDecisionKey(key: string): { saveId: string; segmentId: number } | null {
  const separator = key.lastIndexOf(':');
  if (separator <= 0) return null;
  const saveId = key.slice(0, separator);
  const segmentId = Number(key.slice(separator + 1));
  if (saveId === '' || !Number.isInteger(segmentId) || segmentId <= 0) return null;
  return { saveId, segmentId };
}
