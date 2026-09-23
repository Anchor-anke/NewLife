import type { WorldSetting } from '@/lib/engine/types';

/**
 * 内置世界观：青冥仙途
 *
 * 数值全部集中在 `mechanics` 中，方便单独调参而不动引擎代码。
 *
 * 修为增速（根骨 50、无天赋时，每年积累）：
 *   凡人 8×1.25 = 10    → 约 10 年圆满
 *   炼气 4.8×1.25 = 6   → 约 17 年
 *   筑基 2.88×1.25 = 3.6 → 约 28 年
 *   金丹 1.73×1.25 = 2.2 → 约 46 年
 *   元婴 1.04×1.25 = 1.3 → 约 77 年
 *   化神 0.62×1.25 = 0.8 → 约 128 年
 *   炼虚 0.37×1.25 = 0.5 → 约 214 年
 *   合体 0.22×1.25 = 0.3 → 约 357 年
 *   大乘 0.13×1.25 = 0.2 → 约 597 年
 *   渡劫 0.08×1.25 = 0.1 → 约 1000 年
 *
 * 寿元表与上述曲线是配套设计的：突破所需年数的增长快于寿元增长，
 * 因此越到高境界越紧张，渡劫飞升只属于极少数人。
 * 改任一数值前请先跑 `balance.test.ts` 的模拟，确认寿元机制仍在起作用。
 */
export const qingmingXiantu: WorldSetting = {
  id: 'qingming-xiantu',
  version: 1,
  name: '青冥仙途',
  description:
    '灵气未绝的玄洲，凡人寿不过八十。你自青冥山下一户人家醒来，能否在有限的寿元里，一步步走到渡劫飞升？',
  timeUnit: 'year',

  initialWorldStatus:
    '玄洲东境的青冥山一带。仙门林立却彼此提防，凡人村落散在山脚，灵气比百年前稀薄了许多。',

  rules: [
    '灵气有限：境界越高，突破所需的积累越多，成功的可能也越低。',
    '修士寿元由境界决定，寿元耗尽即坐化，任何丹药都无法延寿。',
    '修为只能通过修炼、机缘与顿悟积累，不能凭空获得。',
    '根骨、悟性、心性、气运在筑基之后极难改变，凡俗手段无法增减。',
    '一切因果皆有代价：夺取他人机缘，必结仇怨。',
    '凡人无法感知灵气，未入炼气期者不能使用法术与法宝。',
    '天劫只在渡劫之时降临，无法回避，只能以修为与心性硬抗。',
  ],

  attributes: [
    {
      key: 'realm',
      label: '境界',
      initialValue: 0,
      min: 0,
      max: 9,
      kind: 'counter',
      integer: true,
      primary: true,
    },
    {
      key: 'cultivation',
      label: '修为',
      initialValue: 0,
      min: 0,
      max: 100,
      kind: 'progress',
      integer: true,
      primary: true,
    },
    {
      key: 'aptitude',
      label: '根骨',
      initialValue: 50,
      min: 0,
      max: 100,
      kind: 'counter',
      integer: true,
      primary: true,
      roll: { min: 30, max: 70 },
    },
    {
      key: 'comprehension',
      label: '悟性',
      initialValue: 50,
      min: 0,
      max: 100,
      kind: 'counter',
      integer: true,
      primary: true,
      roll: { min: 30, max: 70 },
    },
    {
      key: 'willpower',
      label: '心性',
      initialValue: 50,
      min: 0,
      max: 100,
      kind: 'counter',
      integer: true,
      primary: true,
      roll: { min: 30, max: 70 },
    },
    {
      key: 'luck',
      label: '气运',
      initialValue: 50,
      min: 0,
      max: 100,
      kind: 'counter',
      integer: true,
      primary: true,
      roll: { min: 20, max: 80 },
    },
    {
      key: 'reputation',
      label: '声望',
      initialValue: 0,
      min: 0,
      max: 100,
      kind: 'counter',
      integer: true,
    },
    {
      key: 'spiritStones',
      label: '灵石',
      initialValue: 0,
      min: 0,
      kind: 'resource',
      integer: true,
      unit: '块',
    },
  ],

  mechanics: {
    cultivationKey: 'cultivation',
    realmKey: 'realm',
    cultivationMax: 100,
    realmNames: [
      '凡人',
      '炼气',
      '筑基',
      '金丹',
      '元婴',
      '化神',
      '炼虚',
      '合体',
      '大乘',
      '渡劫',
    ],
    // 索引即境界。寿元刻意保持「增长慢于突破所需时间」的斜率——
    // 否则「寿元耗尽」这个核心死亡机制永远不会触发（见 cultivationGain.decayFactor 的说明）。
    lifespanByRealm: [70, 105, 160, 260, 400, 620, 950, 1450, 2200, 3400],

    cultivationGain: {
      base: 8,
      decayFactor: 0.6,
      min: 0.05,
      aptitudeKey: 'aptitude',
      aptitudeScale: 200,
    },

    breakthrough: {
      weights: {
        comprehension: 0.4,
        willpower: 0.3,
        aptitude: 0.2,
        luck: 0.1,
      },
      penaltyPerRealm: 5,
      minProbability: 0.05,
      maxProbability: 0.95,
      failureCultivationLoss: 30,
      lowWillpowerKey: 'willpower',
      lowWillpowerThreshold: 40,
      lowWillpowerPenalty: 5,
    },

    death: {
      willpowerKey: 'willpower',
      willpowerThreshold: 0,
      luckKey: 'luck',
      lethalEventKeywords: [
        '重伤',
        '垂死',
        '陨落',
        '身死',
        '殒命',
        '剧毒',
        '走火入魔',
        '天劫',
        '致命',
        '绝境',
        '魂飞魄散',
      ],
    },

    maxDeltaPerSegment: 30,
    startingAge: 16,
    completionProposalMinRealm: 5,
    segmentSoftLimit: 300,
  },

  endings: {
    lifespan: {
      reason: '寿元耗尽（{realm}期寿止 {lifespan} 年）',
      narrative:
        '寿元在这一年走到了尽头。{realm}期的修为终究没能留住流逝的光阴，你于静室中坐化，享年 {age} 岁。',
    },
    collapse: {
      reason: '心魔噬身',
      narrative:
        '心性崩毁，心魔自内里将你吞没。最后的清醒里只剩一片血色，享年 {age} 岁。',
    },
    ascension: {
      reason: '渡劫成功，羽化飞升',
      narrative:
        '九重天雷散尽，霞光自天顶垂落。你的身影在光中一点点淡去，此界再无人能寻到你的踪迹，唯余一段传说。',
    },
    turnLimit: {
      reason: '岁月流转，此生已尽',
      narrative: '岁月流转，你的故事在此收束。享年 {age} 岁。',
    },
    deathByProposal: '{reason}。你的一生在此戛然而止，享年 {age} 岁。',
    completionByProposal: '{reason}。你的故事在此收束，享年 {age} 岁。',
  },

  talents: [
    {
      id: 'innate-dao-body',
      name: '天生道体',
      description: '生来经脉自通，吐纳灵气远快于常人。',
      modifiers: { cultivationGainMul: 1.1 },
      attributeBonus: { aptitude: 20 },
    },
    {
      id: 'photographic-memory',
      name: '过目不忘',
      description: '经文功法一览即通，参悟关隘时总有灵光。',
      modifiers: { breakthroughBonus: 6 },
      attributeBonus: { comprehension: 15 },
    },
    {
      id: 'deep-blessing',
      name: '福缘深厚',
      description: '屡屡绝处逢生，机缘总在无意间落到你头上。',
      modifiers: {},
      attributeBonus: { luck: 20 },
    },
    {
      id: 'iron-will',
      name: '心志如铁',
      description: '心湖不起波澜，心魔难侵，关隘前亦能咬牙撑住。',
      modifiers: { breakthroughBonus: 4 },
      attributeBonus: { willpower: 20 },
    },
    {
      id: 'wealthy-lineage',
      name: '钟鸣鼎食',
      description: '出身豪族，起步便有灵石傍身，名声在外。',
      modifiers: {},
      attributeBonus: { spiritStones: 50, reputation: 10 },
    },
    {
      id: 'sword-bone',
      name: '剑骨天成',
      description: '骨相锐利如剑，突破时的锋锐之意令关隘为之一开。',
      modifiers: { breakthroughBonus: 8 },
      attributeBonus: { aptitude: 10 },
    },
    {
      id: 'late-bloomer',
      name: '大器晚成',
      description: '早年资质平平，却愈修愈快，后劲绵长。',
      modifiers: { cultivationGainMul: 1.3 },
      attributeBonus: { aptitude: -10 },
    },
    {
      id: 'wandering-hermit',
      name: '云游散人',
      description: '不慕虚名，行踪无定，反倒常遇奇缘。',
      modifiers: { cultivationGainMul: 1.15 },
      attributeBonus: { luck: 10, reputation: -10 },
    },
  ],
};

export default qingmingXiantu;
