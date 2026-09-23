import type { WorldSetting } from '@/lib/engine/types';

/**
 * 内置世界观：星海孤舟
 *
 * 硬科幻拓荒题材。「阶位」是殖民地的成熟度，从勉强活着到能自我延续。
 * 与另外两个世界的差异在于时间尺度：星际航行以年计，一次决策的代价可能是几十年，
 * 而医疗技术能让高阶层的人活得更久——但增长仍追不上建设所需的时间。
 *
 * 修为曲线（科技 50 时每年积累「建设」）：
 *   幸存 13.8 → 约 7 年
 *   立足  7.6 → 约 13 年
 *   自足  4.2 → 约 24 年
 *   繁荣  2.3 → 约 44 年
 *   星港  1.3 → 约 79 年
 *   星区  0.7 → 约 145 年
 */
export const starArk: WorldSetting = {
  id: 'star-ark',
  version: 1,
  name: '星海孤舟',
  description:
    '殖民船「长夜号」在跃迁中偏离了航线，迫降在一颗没有名字的行星上。母星已经联系不上，你这一代人要决定：是活下去，还是活得像个文明。',
  timeUnit: 'year',

  initialWorldStatus:
    '主船体断裂成三截，幸存者不到两千人。生态穹顶只够支撑二十年，而补给船永远不会来了。',

  rules: [
    '光速是硬上限，星际航行以年为单位，一次往返可能就是一代人。',
    '母星已经联系不上了，这个殖民地只能靠自己。',
    '生态穹顶极其脆弱：一次失压、一场瘟疫，几十年的积累就会归零。',
    '技术不能凭空获得，每一项突破都需要资源、时间和试错。',
    '殖民地里每个人都是不可替代的，死亡不只是数字。',
    '机械会老化，人会衰老，维护本身就是生存的一部分。',
    '没有第二次补给船。',
  ],

  attributes: [
    {
      key: 'stage',
      label: '阶段',
      initialValue: 0,
      min: 0,
      max: 7,
      kind: 'counter',
      integer: true,
      primary: true,
    },
    {
      key: 'progress',
      label: '建设',
      initialValue: 0,
      min: 0,
      max: 100,
      kind: 'progress',
      integer: true,
      primary: true,
    },
    {
      key: 'tech',
      label: '科技',
      initialValue: 50,
      min: 0,
      max: 100,
      kind: 'counter',
      integer: true,
      primary: true,
      roll: { min: 30, max: 70 },
    },
    {
      key: 'wit',
      label: '智略',
      initialValue: 50,
      min: 0,
      max: 100,
      kind: 'counter',
      integer: true,
      primary: true,
      roll: { min: 30, max: 70 },
    },
    {
      key: 'vigor',
      label: '体能',
      initialValue: 50,
      min: 0,
      max: 100,
      kind: 'counter',
      integer: true,
      primary: true,
      roll: { min: 30, max: 70 },
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
      key: 'resources',
      label: '资源',
      initialValue: 0,
      min: 0,
      kind: 'resource',
      integer: true,
      unit: '单位',
    },
  ],

  mechanics: {
    cultivationKey: 'progress',
    realmKey: 'stage',
    cultivationMax: 100,
    realmNames: ['幸存', '立足', '自足', '繁荣', '星港', '星区', '星系', '文明'],
    // 医疗与生命维持技术随阶段提升。整张表必须保证「顶阶可达但极难」。
    lifespanByRealm: [80, 110, 150, 205, 290, 400, 540, 720],

    cultivationGain: {
      base: 11,
      decayFactor: 0.55,
      min: 0.5,
      aptitudeKey: 'tech',
      aptitudeScale: 200,
    },

    breakthrough: {
      weights: {
        tech: 0.3,
        wit: 0.3,
        resolve: 0.25,
        fortune: 0.15,
      },
      penaltyPerRealm: 6,
      minProbability: 0.05,
      maxProbability: 0.95,
      failureCultivationLoss: 28,
      lowWillpowerKey: 'resolve',
      lowWillpowerThreshold: 40,
      lowWillpowerPenalty: 5,
    },

    death: {
      willpowerKey: 'resolve',
      willpowerThreshold: 0,
      luckKey: 'fortune',
      lethalEventKeywords: [
        '失压',
        '辐射',
        '致命',
        '事故',
        '感染',
        '濒死',
        '船毁',
        '缺氧',
        '塌方',
        '爆炸',
      ],
    },

    maxDeltaPerSegment: 30,
    startingAge: 20,
    completionProposalMinRealm: 5,
    segmentSoftLimit: 250,
  },

  endings: {
    lifespan: {
      reason: '寿命耗尽（{realm}·{lifespan} 岁）',
      narrative:
        '医疗舱在这一年停止了工作。你活过了这颗行星上的大多数人，{realm}的日子到此为止，享年 {age} 岁。',
    },
    collapse: {
      reason: '精神崩溃',
      narrative:
        '穹顶外的黑暗终于压垮了你。你不再走出舱门，也不再开口说话，享年 {age} 岁。',
    },
    ascension: {
      reason: '火种已经不需要你了',
      narrative:
        '最后一艘殖民船离港那天，你站在观景窗前看了很久。你这一生建起来的东西，已经能自己走下去了。',
    },
    turnLimit: {
      reason: '故事在此收束',
      narrative: '你的故事在此收束。享年 {age} 岁。',
    },
    deathByProposal: '{reason}。你的一生在此戛然而止，享年 {age} 岁。',
    completionByProposal: '{reason}。你的故事在此收束，享年 {age} 岁。',
  },

  talents: [
    {
      id: 'engineer-raised',
      name: '工程师出身',
      description: '你从小在维修舱长大，闭着眼也能拆开一台循环泵。',
      modifiers: {},
      attributeBonus: { tech: 20 },
    },
    {
      id: 'former-soldier',
      name: '前特种兵',
      description: '跃迁前你隶属护航部队，身体是你最可靠的资产。',
      modifiers: {},
      attributeBonus: { vigor: 20 },
    },
    {
      id: 'negotiator',
      name: '谈判专家',
      description: '两千个人挤在一个穹顶下，最稀缺的资源是让人不打架的本事。',
      modifiers: { breakthroughBonus: 4 },
      attributeBonus: { wit: 20 },
    },
    {
      id: 'lucky-drift',
      name: '幸运星',
      description: '你活下来这件事本身就不太符合概率。',
      modifiers: {},
      attributeBonus: { fortune: 20 },
    },
    {
      id: 'stubborn',
      name: '顽固分子',
      description: '所有人都说不行的时候，你偏要再试一次。',
      modifiers: { breakthroughBonus: 4 },
      attributeBonus: { resolve: 20 },
    },
    {
      id: 'merchant-heir',
      name: '富商遗孤',
      description: '你的家族买下了这艘船的货舱，也把资源留给了你。',
      modifiers: {},
      attributeBonus: { resources: 80, resolve: 10 },
    },
    {
      id: 'lower-deck',
      name: '底层出身',
      description: '你在最下层的舱室里长大，知道怎么用最少的资源做最多的事。',
      modifiers: { cultivationGainMul: 1.2 },
      attributeBonus: { resources: -10 },
    },
    {
      id: 'lone-walker',
      name: '独行者',
      description: '你不擅长和人打交道，但一个人能做的事比你想象的多。',
      modifiers: { cultivationGainMul: 1.25 },
      attributeBonus: { wit: -10 },
    },
  ],
};

export default starArk;
