import type { WorldSetting } from '@/lib/engine/types';

/**
 * 内置世界观：浮生记
 *
 * 现代都市题材。新开局使用 open_life：事业、健康和关系各自变化，
 * 不再把社会阶层当成修仙境界，也不靠晋阶续命。
 *
 * 下方 mechanics 保留原规则的数值参数，仅供旧存档与旧模拟器对照。
 * 旧版修为曲线（学识 50 时每年积累「事业」）：
 *   无依 9×1.25 = 11.3 → 约 9 年
 *   温饱 7.7×1.25 = 9.7 → 约 10 年
 *   小康 6.7×1.25 = 8.3 → 约 12 年
 *   中产 5.7×1.25 = 7.2 → 约 14 年
 *   优渥 4.9×1.25 = 6.2 → 约 16 年
 *   显达 4.2×1.25 = 5.3 → 约 19 年
 * 越往上越难，且寿元增长远跟不上，所以大多数人止步于中产前后。
 */
export const fushengJi: WorldSetting = {
  id: 'fusheng-ji',
  version: 1,
  name: '浮生记',
  description:
    '一座普通的城市，一群普通的人。你十八岁那年离开家，往后几十年要在这座城市里挣出自己的一席之地。没有奇迹，只有选择。',
  timeUnit: 'year',
  ruleset: {
    kind: 'open_life',
    version: 2,
    healthKey: 'health',
    spiritKey: 'spirit',
    careerKey: 'career',
    luckKey: 'fortune',
    lethalEventKeywords: ['重病', '绝症', '车祸', '意外', '重症', '濒死', '猝死', '凶案', '事故'],
    startingAge: 18,
    legacyHiddenKeys: ['stratum'],
    agingStartAge: 45,
    annualHealthLoss: 1,
    maxAge: 105,
    completionMinAge: 55,
    maxDeltaPerSegment: 25,
    segmentSoftLimit: 80,
    naturalDeath: {
      reason: '生命走到尽头',
      narrative: '这一年，你的身体再也无法支撑。城市照常醒来，而你的一生停在了 {age} 岁。',
    },
    healthDeath: {
      reason: '健康耗尽',
      narrative: '多年积累的病痛终于让你停下脚步。你在 {age} 岁离开了这个世界。',
    },
  },

  initialWorldStatus:
    '经济增速放缓，房价高企，行业每隔几年就换一次风口。你手里只有一张车票和不多的一点钱。',

  rules: [
    '这个世界没有超凡力量，任何人都无法突破肉体的极限。',
    '财富与地位可以改善生活，但买不来寿命，也换不回已经垮掉的身体。',
    '时间是唯一不可再生的资源：一年只能做一件事，做了这个就做不了那个。',
    '身体会随年龄衰退。年轻时透支的健康，晚年都要连本带利地还。',
    '人际关系的建立需要经年累月，崩塌却往往只在一瞬间。',
    '任何成就都需要积累，没有一夜之间的阶层跃迁。',
    '机遇偏爱有准备的人，但运气本身就是一种实力。',
  ],

  attributes: [
    {
      key: 'stratum',
      label: '阶层',
      initialValue: 0,
      min: 0,
      max: 6,
      kind: 'counter',
      integer: true,
      primary: true,
    },
    {
      key: 'career',
      label: '事业',
      initialValue: 0,
      min: 0,
      max: 100,
      kind: 'counter',
      integer: true,
      primary: true,
    },
    {
      key: 'health',
      label: '体魄',
      initialValue: 55,
      min: 0,
      max: 100,
      kind: 'counter',
      integer: true,
      primary: true,
      roll: { min: 35, max: 75 },
    },
    {
      key: 'insight',
      label: '学识',
      initialValue: 50,
      min: 0,
      max: 100,
      kind: 'counter',
      integer: true,
      primary: true,
      roll: { min: 25, max: 75 },
    },
    {
      key: 'empathy',
      label: '情商',
      initialValue: 50,
      min: 0,
      max: 100,
      kind: 'counter',
      integer: true,
      primary: true,
      roll: { min: 25, max: 75 },
    },
    {
      key: 'fortune',
      label: '际遇',
      initialValue: 50,
      min: 0,
      max: 100,
      kind: 'counter',
      integer: true,
      primary: true,
      roll: { min: 20, max: 80 },
    },
    {
      key: 'spirit',
      label: '心气',
      initialValue: 55,
      min: 0,
      max: 100,
      kind: 'counter',
      integer: true,
      primary: true,
      roll: { min: 30, max: 80 },
    },
    {
      key: 'wealth',
      label: '积蓄',
      initialValue: 0,
      min: 0,
      kind: 'resource',
      integer: true,
      unit: '万元',
    },
  ],

  mechanics: {
    cultivationKey: 'career',
    realmKey: 'stratum',
    cultivationMax: 100,
    realmNames: ['无依', '温饱', '小康', '中产', '优渥', '显达', '名门'],
    // 生活条件越好越长寿。整张表必须让「顶阶可达但极难」——
    // 次高阶的寿元要明显高过踏入顶阶所需年龄，否则顶阶永远只是个摆设。
    lifespanByRealm: [62, 72, 80, 87, 93, 99, 105],

    cultivationGain: {
      base: 11,
      decayFactor: 0.86,
      min: 1.5,
      aptitudeKey: 'insight',
      aptitudeScale: 200,
    },

    breakthrough: {
      weights: {
        insight: 0.35,
        empathy: 0.3,
        health: 0.2,
        fortune: 0.15,
      },
      penaltyPerRealm: 5,
      minProbability: 0.05,
      maxProbability: 0.95,
      failureCultivationLoss: 20,
      lowWillpowerKey: 'spirit',
      lowWillpowerThreshold: 35,
      lowWillpowerPenalty: 4,
    },

    death: {
      willpowerKey: 'spirit',
      willpowerThreshold: 0,
      luckKey: 'fortune',
      lethalEventKeywords: [
        '重病',
        '绝症',
        '车祸',
        '意外',
        '重症',
        '濒死',
        '猝死',
        '凶案',
        '事故',
        '昏迷不醒',
      ],
    },

    maxDeltaPerSegment: 25,
    startingAge: 18,
    completionProposalMinRealm: 4,
    segmentSoftLimit: 200,
  },

  endings: {
    lifespan: {
      reason: '寿数已尽（{realm}·{lifespan} 岁）',
      narrative:
        '身体在这一年彻底垮了下来。{realm}的日子也没能换来更多时间，你在一个寻常的清晨安静地走了，享年 {age} 岁。',
    },
    collapse: {
      reason: '心力交瘁',
      narrative:
        '你再也撑不住了。那些压了很多年的东西一起涌上来，你放弃了挣扎，享年 {age} 岁。',
    },
    ascension: {
      reason: '功成身退，此生无憾',
      narrative:
        '你站在自己一手建起来的一切面前，忽然觉得够了。往后余生，终于可以只为自己活。',
    },
    turnLimit: {
      reason: '这一段人生在此收束',
      narrative: '日子一天天过去，你在 {age} 岁回望此前走过的路，决定翻开新的一页。',
    },
    deathByProposal: '{reason}。你的一生在此戛然而止，享年 {age} 岁。',
    completionByProposal: '{reason}。你在 {age} 岁为这一段人生作了收束，往后的日子仍属于你。',
  },

  talents: [
    {
      id: 'scholar-family',
      name: '书香门第',
      description: '父母都是老师，家里最多的东西是书。',
      modifiers: {},
      attributeBonus: { insight: 18, wealth: 20 },
    },
    {
      id: 'iron-constitution',
      name: '体格过人',
      description: '从小到大没进过医院，熬几个通宵也不见疲态。',
      modifiers: {},
      attributeBonus: { health: 20 },
    },
    {
      id: 'people-person',
      name: '长袖善舞',
      description: '你天生知道该在什么时候说什么话。',
      modifiers: {},
      attributeBonus: { empathy: 20 },
    },
    {
      id: 'lucky-star',
      name: '时来运转',
      description: '你总能在最后一刻赶上那班车。',
      modifiers: {},
      attributeBonus: { fortune: 20 },
    },
    {
      id: 'fallen-family',
      name: '家道中落',
      description: '你见过好日子，也见过它怎么没的。这让你比别人更早懂事。',
      modifiers: {},
      attributeBonus: { insight: 20, spirit: 12, wealth: -20 },
    },
    {
      id: 'poor-but-driven',
      name: '寒门贵子',
      description: '你什么都没有，所以什么都敢试。',
      modifiers: {},
      attributeBonus: { spirit: 10, career: 10 },
    },
    {
      id: 'old-soul',
      name: '少年老成',
      description: '同龄人还在迷茫的时候，你已经想清楚了自己要什么。',
      modifiers: {},
      attributeBonus: { spirit: 20, career: 5 },
    },
    {
      id: 'late-bloomer-life',
      name: '大器晚成',
      description: '起步比人慢，但走得比人远。代价是身体。',
      modifiers: {},
      attributeBonus: { career: -10, insight: 20, health: -10 },
    },
  ],
};

export default fushengJi;
