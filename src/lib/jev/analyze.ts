import type { LifeSegmentRecord } from '../engine/types';

/**
 * 「Jev 分数 vs 玩家实际选择」的对齐分析。
 *
 * 数据来源是段记录里的两个既有字段：`segment.decision` + `jevScores` 是推演，
 * 下一段的 `playerAction` 是玩家在岔路口真正交出的决定（自由输入的玩家不匹配
 * 任何选项文本，单独计数）。全部是纯读取，不需要任何额外埋点。
 *
 * 这个模块刻意只做**可擦除语法**的纯 TypeScript（类型 import + 纯函数）：
 * `scripts/analyze-jev.mjs` 会用 node 的类型剥离直接加载它，保持单一实现。
 *
 * 怎么读结果：如果 `topPickRate` 长期接近 `topMassAvg`（玩家选最高分选项的频率
 * 约等于最高分选项平均拿到多少概率），说明分数对「这个玩家会怎么走」没有超出
 * 分布本身的预测力——对齐分析的意义就是把这个问题交给数据回答。
 */

export interface JevAlignmentReport {
  /** 岔路总数（带 decision 的段落） */
  decisionsTotal: number;
  /** 其中带 jevScores 的（其余是未配置 Jev 或打分失败） */
  decisionsScored: number;
  /** 有分数、且下一段的 playerAction 命中选项文本的可分析样本数 */
  paired: number;
  /** 有分数、但玩家交出的是自由输入（没命中任何选项文本）的次数 */
  freeForm: number;
  /** 玩家选择了分数最高选项的次数 */
  topPicked: number;
  /** topPicked / paired */
  topPickRate: number;
  /** 玩家所选选项的平均概率质量 */
  chosenMassAvg: number;
  /** 最高选项的平均概率（对照基线） */
  topMassAvg: number;
}

export function emptyReport(): JevAlignmentReport {
  return {
    decisionsTotal: 0,
    decisionsScored: 0,
    paired: 0,
    freeForm: 0,
    topPicked: 0,
    topPickRate: 0,
    chosenMassAvg: 0,
    topMassAvg: 0,
  };
}

export function analyzeJevAlignment(
  segments: readonly LifeSegmentRecord[],
): JevAlignmentReport {
  const report = emptyReport();

  // 段落按段号配对；导出/导入理论上保序，但这里不做这个假设
  const ordered = [...segments].sort((a, b) => a.segmentId - b.segmentId);

  let chosenMassSum = 0;
  let topMassSum = 0;

  for (let index = 0; index < ordered.length; index += 1) {
    const record = ordered[index];
    if (!record) continue;
    const decision = record.segment.decision;
    if (!decision) continue;
    report.decisionsTotal += 1;

    const scores = record.jevScores;
    if (!scores) continue;
    report.decisionsScored += 1;

    // 玩家在岔路口的选择 = 下一段的 playerAction。最后一段的岔路还停着，没有下文。
    const next = ordered[index + 1];
    const choice = next === undefined ? undefined : next.playerAction;
    if (choice === undefined) continue;

    const chosenIndex = decision.options.indexOf(choice);
    if (chosenIndex < 0) {
      report.freeForm += 1;
      continue;
    }

    report.paired += 1;
    if (chosenIndex === scores.topIndex) report.topPicked += 1;
    chosenMassSum += scores.probabilities[chosenIndex] ?? 0;
    topMassSum += scores.probabilities[scores.topIndex] ?? 0;
  }

  if (report.paired > 0) {
    report.topPickRate = report.topPicked / report.paired;
    report.chosenMassAvg = chosenMassSum / report.paired;
    report.topMassAvg = topMassSum / report.paired;
  }

  return report;
}

/** 面向终端的报告排版。 */
export function formatReport(report: JevAlignmentReport): string {
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  const lines = [
    `岔路 ${report.decisionsTotal} 处，带推演分数 ${report.decisionsScored} 处`,
    `可分析样本 ${report.paired} 个（另有自由输入 ${report.freeForm} 次不计入）`,
  ];

  if (report.paired === 0) {
    lines.push('样本不足，暂无法评估。多玩几局再回来。');
    return lines.join('\n');
  }

  lines.push(
    `玩家选了推演最高分选项：${report.topPicked}/${report.paired}（${percent(report.topPickRate)}）`,
    `所选选项的平均概率质量：${percent(report.chosenMassAvg)}`,
    `最高分选项的平均概率质量：${percent(report.topMassAvg)}（对照基线）`,
  );

  const margin = report.topPickRate - report.topMassAvg;
  if (margin > 0.1) {
    lines.push('读法：玩家选最高分选项的频率明显高于基线——分数对你的选择有预测力。');
  } else if (margin < -0.1) {
    lines.push('读法：玩家反而经常避开最高分选项——推演在往「不像他」的方向指。');
  } else {
    lines.push('读法：与基线相当——分数没有超出分布本身的预测力，参考价值存疑。');
  }

  return lines.join('\n');
}
