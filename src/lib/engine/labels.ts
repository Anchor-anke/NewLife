import type { WorldSetting } from './types';

/**
 * 世界观文案工具。
 *
 * 引擎只应该知道「哪个属性是进度、哪个是阶位、哪个是意志」，不应该知道
 * 它们叫什么。所有面向玩家的措辞都必须经由这些函数取名，否则换个题材
 * （修仙 → 现代都市）就会出现「你的修为停滞了」这种明显串味的文案。
 */

/** 取属性在界面上的显示名。找不到时退回属性键，便于发现拼写错误。 */
export function attributeLabel(world: WorldSetting, key: string): string {
  return world.attributes.find((attribute) => attribute.key === key)?.label ?? key;
}

/** 取阶位名。越界时给出可读的兜底值。 */
export function tierName(world: WorldSetting, tier: number): string {
  return world.mechanics.realmNames[tier] ?? `第 ${tier} 阶`;
}

/**
 * 填充文本模板里的占位符。
 *
 * 只做简单的字符串替换——结局文案是世界观作者写的，不需要表达式能力。
 * 未识别的占位符原样保留，方便作者发现自己写错了。
 */
export function fillTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

/** 时间单位的显示名。 */
export const TIME_UNIT_LABELS: Record<WorldSetting['timeUnit'], string> = {
  year: '年',
  month: '月',
  day: '日',
};
