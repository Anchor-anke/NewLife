#!/usr/bin/env node
/**
 * 「Jev 分数 vs 玩家实际选择」的对齐分析。
 *
 * 数据来源是存档导出的 JSON（存档页的「导出」按钮，或 e2e 落下的 export.json）。
 * 推演分数在段记录的 jevScores 字段里、玩家的实际选择在下一段的 playerAction
 * 里，全部已经在数据中，本脚本只做配对与统计。
 *
 * 分析逻辑在 src/lib/jev/analyze.ts（带单测）；这里只负责读文件与排版。
 * node 24 的类型剥离可以直接加载那个纯 TS 模块，不需要任何构建步骤。
 *
 * 用法：
 *   node scripts/analyze-jev.mjs 导出.json [更多导出.json ...]
 *   npm run analyze:jev -- 导出.json
 */

import { readFileSync } from 'node:fs';
import { analyzeJevAlignment, formatReport } from '../src/lib/jev/analyze.ts';

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.log('用法：node scripts/analyze-jev.mjs <存档导出.json> [...]');
  process.exit(1);
}

let hadError = false;
for (const filePath of paths) {
  let payload;
  try {
    payload = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error(`✗ ${filePath}：读不出来（${error.message}）`);
    hadError = true;
    continue;
  }

  // 兼容两种输入：完整的导出包 { formatVersion, save, segments }，或裸的段落数组
  const segments = Array.isArray(payload) ? payload : payload?.segments;
  if (!Array.isArray(segments)) {
    console.error(`✗ ${filePath}：不是存档导出（找不到 segments）`);
    hadError = true;
    continue;
  }

  const save = Array.isArray(payload) ? null : (payload.save ?? null);
  const title = save
    ? `《${save.world?.name ?? '?'}》· ${save.character?.name ?? '?'}`
    : filePath;

  console.log(`\n── ${title} ──`);
  console.log(formatReport(analyzeJevAlignment(segments)));
}

if (hadError) process.exitCode = 1;
