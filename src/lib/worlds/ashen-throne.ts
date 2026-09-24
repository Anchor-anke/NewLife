import type { WorldSetting } from '@/lib/engine/types';

/**
 * 内置世界观：灰烬王座
 *
 * 低魔奇幻题材。「阶位」是冒险者公会评定的等级，进阶靠的是实打实的战功。
 * 与修仙世界的差异在于：这里没有「闭关苦修」这回事，修为只能从危险里挣，
 * 所以时间跨度更短、单次波动更大。
 *
 * 修为曲线（力量 50 时每年积累「功业」）：
 *   无名 12.5 → 约 8 年
 *   铜牌  9.7 → 约 13 年
 *   银牌  6.0 → 约 21 年
 *   金牌  3.7 → 约 34 年
 *   白金  2.3 → 约 54 年
 *   秘银  1.4 → 约 87 年
 * 高阶冒险者虽然寿命更长，但每一级的耗时也涨得更快，因此绝大多数人停在秘银。
 */
export const ashenThrone: WorldSetting = {
  id: 'ashen-throne',
  version: 1,
  name: '灰烬王座',
  description:
    '王国边境的灰烬领，魔物自裂谷涌出已经三代人了。你十六岁那年接过一把生锈的短剑，从此靠接委托活着。',
  timeUnit: 'year',
  ruleset: {
    kind: 'open_life', version: 2,
    healthKey: 'health', spiritKey: 'resolve', careerKey: 'exploits', luckKey: 'fortune',
    lethalEventKeywords: ['重伤', '致命', '贯穿', '中毒', '濒死', '断气', '焚身'],
    startingAge: 16, legacyHiddenKeys: [],
    agingStartAge: 45, annualHealthLoss: 1, maxAge: 95, completionMinAge: 45,
    maxDeltaPerSegment: 30, segmentSoftLimit: 80,
    earnedRank: { key: 'rank', evidenceKeywords: ['委托完成', '公会评定', '公会授予', '公会晋升'] },
    naturalDeath: { reason: '生命走到尽头', narrative: '多年的旅途终于结束。你在 {age} 岁合上了眼。' },
    healthDeath: { reason: '伤病耗尽体力', narrative: '往年留下的伤再也没有好转，你在 {age} 岁停下了脚步。' },
  },

  initialWorldStatus:
    '裂谷的魔物活动愈发频繁，边境三座城镇已被放弃。冒险者公会悬赏翻倍，但回来的队伍越来越少。',

  rules: [
    '魔法真实存在，但代价高昂：每次施法都要消耗生命力或珍贵材料。',
    '剑刃与爪牙不长眼，死亡往往来得毫无预兆。',
    '冒险者公会只依据完成的委托与正式评定调整评级；评级不会延长寿命。',
    '名声是双刃剑：它带来委托，也招来仇敌。',
    '治疗可以救回重伤，但救不回已经失去的肢体与理智。',
    '没有无代价的力量，任何捷径都在暗中标好了价钱。',
    '同伴会死，这是这一行的常态。',
  ],

  attributes: [
    { key: 'health', label: '健康', initialValue: 60, min: 0, max: 100, kind: 'counter', integer: true, primary: true, roll: { min: 40, max: 80 } },
    {
      key: 'rank',
      label: '公会评级',
      initialValue: 0,
      min: 0,
      max: 7,
      kind: 'counter',
      integer: true,
      primary: true,
    },
    {
      key: 'exploits',
      label: '功业',
      initialValue: 0,
      min: 0,
      max: 100,
      kind: 'counter',
      integer: true,
      primary: true,
    },
    {
      key: 'might',
      label: '力量',
      initialValue: 50,
      min: 0,
      max: 100,
      kind: 'counter',
      integer: true,
      primary: true,
      roll: { min: 30, max: 70 },
    },
    {
      key: 'agility',
      label: '敏捷',
      initialValue: 50,
      min: 0,
      max: 100,
      kind: 'counter',
      integer: true,
      primary: true,
      roll: { min: 30, max: 70 },
    },
    {
      key: 'arcana',
      label: '奥术',
      initialValue: 30,
      min: 0,
      max: 100,
      kind: 'counter',
      integer: true,
      primary: true,
      roll: { min: 10, max: 60 },
    },
    {
      key: 'resolve',
      label: '意志',
      initialValue: 55,
      min: 0,
      max: 100,
      kind: 'counter',
      integer: true,
      primary: true,
      roll: { min: 30, max: 75 },
    },
    {
      key: 'fortune',
      label: '机运',
      initialValue: 50,
      min: 0,
      max: 100,
      kind: 'counter',
      integer: true,
      roll: { min: 20, max: 80 },
    },
    {
      key: 'gold',
      label: '金币',
      initialValue: 0,
      min: 0,
      kind: 'resource',
      integer: true,
      unit: '枚',
    },
  ],

  mechanics: {
    cultivationKey: 'exploits',
    realmKey: 'rank',
    cultivationMax: 100,
    realmNames: ['无名', '铜牌', '银牌', '金牌', '白金', '秘银', '传说', '神话'],
    // 阶位越高，治疗与护身手段越强，寿命随之增长；
    // 但增长必须快过突破所需时间，否则顶阶永远不可达。
    lifespanByRealm: [60, 80, 105, 145, 215, 310, 420, 560],

    cultivationGain: {
      base: 10,
      decayFactor: 0.66,
      min: 0.4,
      aptitudeKey: 'might',
      aptitudeScale: 200,
    },

    breakthrough: {
      weights: {
        might: 0.3,
        resolve: 0.25,
        agility: 0.2,
        arcana: 0.1,
        fortune: 0.15,
      },
      penaltyPerRealm: 6,
      minProbability: 0.05,
      maxProbability: 0.95,
      failureCultivationLoss: 30,
      lowWillpowerKey: 'resolve',
      lowWillpowerThreshold: 40,
      lowWillpowerPenalty: 5,
    },

    death: {
      willpowerKey: 'resolve',
      willpowerThreshold: 0,
      luckKey: 'fortune',
      lethalEventKeywords: [
        '重伤',
        '致命',
        '贯穿',
        '斩',
        '陨落',
        '中毒',
        '濒死',
        '断气',
        '被吞',
        '焚身',
      ],
    },

    maxDeltaPerSegment: 30,
    startingAge: 16,
    completionProposalMinRealm: 5,
    segmentSoftLimit: 250,
  },

  endings: {
    lifespan: {
      reason: '旧伤不愈（{realm}·{lifespan} 岁）',
      narrative:
        '往年那些伤在这一年一起发作。你没能再站起来，{realm}的故事在某个清晨安静地结束了，享年 {age} 岁。',
    },
    collapse: {
      reason: '意志崩毁',
      narrative:
        '你见过太多不该见的东西。某个夜里你放下剑，再也没有把它捡起来，享年 {age} 岁。',
    },
    ascension: {
      reason: '封神，名字被写进歌谣',
      narrative:
        '吟游诗人开始传唱你的名字，而你已经走向更远的地方。灰烬王座空着，但没有人敢坐上去。',
    },
    turnLimit: {
      reason: '冒险在此告一段落',
      narrative: '你在 {age} 岁暂时放下了手中的剑，回望这一路的委托与同伴。',
    },
    deathByProposal: '{reason}。你的一生在此戛然而止，享年 {age} 岁。',
    completionByProposal: '{reason}。你在 {age} 岁告别了这一段冒险。',
  },

  talents: [
    {
      id: 'born-strong',
      name: '天生神力',
      description: '你十四岁时就能把成年人的长剑挥得像根树枝。',
      modifiers: {},
      attributeBonus: { might: 20 },
    },
    {
      id: 'light-as-feather',
      name: '轻如鸿羽',
      description: '你走路几乎没有声音，躲开的东西比挡住的多。',
      modifiers: {},
      attributeBonus: { agility: 20 },
    },
    {
      id: 'arcane-affinity',
      name: '秘法亲和',
      description: '咒文在你眼里不是符号，是能读懂的句子。',
      modifiers: {},
      attributeBonus: { arcana: 20 },
    },
    {
      id: 'lucky-coin',
      name: '幸运币',
      description: '你有一枚从不离身的旧币，它替你挡过两次致命伤。',
      modifiers: {},
      attributeBonus: { fortune: 20 },
    },
    {
      id: 'heart-of-stone',
      name: '铁石心肠',
      description: '同伴死在面前，你也能把刀拔出来继续往前走。',
      modifiers: {},
      attributeBonus: { resolve: 20 },
    },
    {
      id: 'fallen-noble',
      name: '没落贵族',
      description: '家族只剩一个姓氏和一箱子旧装备，但底子还在。',
      modifiers: {},
      attributeBonus: { gold: 60, resolve: 10 },
    },
    {
      id: 'survivor',
      name: '战地余生',
      description: '你从一场全军覆没的远征里爬了回来。',
      modifiers: {},
      attributeBonus: { health: 15, resolve: -10 },
    },
    {
      id: 'desperado',
      name: '亡命之徒',
      description: '你不在乎规则，只在乎能不能活到明天。',
      modifiers: {},
      attributeBonus: { exploits: 15, fortune: -10 },
    },
  ],
};

export default ashenThrone;
