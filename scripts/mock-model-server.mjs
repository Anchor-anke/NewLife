#!/usr/bin/env node
/**
 * 本地 OpenAI 兼容模拟服务。
 *
 * 用途：在没有 API Key、也不想烧 token 的情况下，完整验证「浏览器 → 模型适配层 →
 * 段落管线 → 结算 → 存档」这条链路是否真的通。它同时验证了跨域预检——
 * 真实供应商不允许浏览器直连时，报错形态就是这个服务故意不返回 CORS 头时的样子。
 *
 * 用法：
 *   node scripts/mock-model-server.mjs            # 监听 127.0.0.1:8787
 *   node scripts/mock-model-server.mjs --port 9000
 *
 * 然后在应用里把接口地址填成 http://127.0.0.1:8787/v1 ，Key 随便填，模型名填 mock。
 *
 * 同一个服务还模拟了 Jev（System One 协议）的打分端点：
 * 在设置里把 Jev 的接口地址填成 http://127.0.0.1:8787 即可，路径 `/v1/systemone`
 * 会返回确定性的选项概率（序号 1 的选项最高）。
 *
 * 运行时可以通过控制接口切换行为（端到端脚本用它覆盖不同场景）：
 *   GET  /control                          查看当前状态
 *   POST /control {"advanceYears":60}      固定每段的跨度，几步跑到寿元耗尽
 *   POST /control {"proposeDecision":true} 每段都提一个岔路（用来验证决策卡）
 *   POST /control {"delayMs":6000}         拉长响应，好在生成中刷新页面验证崩溃恢复
 *   POST /control {"emptyWithLength":true} 返回空内容 + finish_reason: length（复现被截断）
 *   POST /control {"jevFail":true}         打分端点返回 500（复现 Jev 降级路径）
 */

import { createServer } from 'node:http';

const args = process.argv.slice(2);
const portArgIndex = args.indexOf('--port');
const PORT = portArgIndex >= 0 ? Number(args[portArgIndex + 1]) : 8787;
const HOST = '127.0.0.1';

/** 关闭跨域支持，用来复现「供应商不允许浏览器直连」的失败形态。 */
const NO_CORS = args.includes('--no-cors');

/**
 * 运行时可调状态，通过 `POST /control` 修改。
 *
 * 有了它，端到端脚本可以在同一次运行里覆盖多种场景，而不必反复重启服务：
 * - `advanceYears`     固定每段跨度，几步就能跑到寿元耗尽，用来验证结局流程
 * - `proposeDecision`  每段都提岔路，用来验证决策卡与门槛（配合 `advanceYears` 大步
 *                      推进，第一段就会因为突破而停车）
 * - `delayMs`          拉长响应时间，好在「生成中」的时候刷新页面，验证崩溃恢复提示
 */
const state = {
  delayMs: 350,
  /** null 表示按阶位推导；设成数字则每段固定推进这么多年。 */
  advanceYears: null,
  proposeDecision: false,
  /**
   * 复现「响应被输出上限截断」的失败形态：返回空内容 + finish_reason: length。
   * 用来验证连接自检不会误判，以及段落生成会给出可操作的提示。
   */
  emptyWithLength: false,
  /** 打分端点一律返回 500，用来验证界面在 Jev 故障时的降级（不阻塞决策）。 */
  jevFail: false,
};

const REALMS = [
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
];

/**
 * 条目正文。
 *
 * 写法刻意对齐提示词里的要求：**一到两句话，一般 15~40 字**，
 * 有具体的人、动作与物件，而不是主谓宾摘要。
 * 「周砚捎信，得一子，唤作念山」这种电报体是不合格的示范。
 */
const ENTRY_TEXTS = {
  cultivation: [
    '你把大半年的时间都交给了打坐与吐纳',
    '日子过得极慢，慢到能听见自己血流的声音',
    '你在崖边坐了整整一天，看云从脚下漫过去',
    '你翻遍了能借到的典籍，有几处忽然就通了',
  ],
  event: [
    '山下的集市换了新的管事，规矩也跟着变了',
    '风从谷口灌进来，带着湿冷的土腥气',
    '夜里落了雪，天亮时整座山都白了一层',
    '远处的钟声压过了集市上的人声',
  ],
  relationship: [
    '一个同样在赶路的人与你同行了一段，没留下姓名',
    '周砚托人捎来一封信，说家里添了个儿子，取名念山',
    '有人在你门前站了很久，最终还是没有敲门',
  ],
  fortune: [
    '一场机缘落到你头上，来得毫无预兆',
    '你在旧书堆里翻到半页残卷，边角被人反复摩挲过',
    '山道上有人把一样东西塞进你手里，转身就走了',
  ],
  setback: [
    '你受了伤，养了很久，伤好之后有些事反而想通了',
    '你试着再往前走一步，差了一线，此后半年都没能静下心',
    '一场变故让你失去了些东西，你没有对人提起',
  ],
  /**
   * 收尾的 milestone 条目。
   *
   * 措辞落在「转折」上——程序的决策门槛里有一条是「条目命中分量关键词」，
   * 模拟服务得给出一段真的够格停车的段落，端到端才能稳定走到决策卡那一步。
   */
  milestone: ['你跨过了一道多年未过的坎，这是你人生的转折'],
};

/**
 * 条目类型的轮转顺序。
 *
 * 刻意让相邻条目的类型不同——提示词里说了「连续 3 条同类型会被判为流水账
 * 并退回重写」，模拟服务自己当然也要守规矩，否则它测的就是另一条路径了。
 */
const ENTRY_KIND_CYCLE = [
  'cultivation',
  'event',
  'cultivation',
  'setback',
  'relationship',
  'fortune',
];

const OPENINGS = [
  '晨雾还没散尽，山道上只有你一个人的脚印。',
  '这一年的春天来得迟，山脚的桃花开了又谢，你站在门前看了很久。',
  '风从谷口灌进来，带着湿冷的土腥气。',
  '夜里落了雪，天亮时整座山都白了一层。',
];

const CLOSINGS = [
  '你站起身，拍了拍衣摆上的灰。',
  '天色暗下来了，该回去了。',
  '你没有再回头。',
  '远处的钟声又响了一次。',
];

function pick(list, seed) {
  return list[seed % list.length];
}

function extract(pattern, text, fallback) {
  const match = pattern.exec(text);
  return match?.[1] ?? fallback;
}

/**
 * 从角色硬状态里读出当前阶位名。
 *
 * 提示词里的写法是 `当前阶位「凡人」，寿元上限 70 岁`，因此不能去匹配
 * 「X期寿元上限」——那个格式早就改了，写错会静默回退到最低阶位，
 * 让模拟出来的节奏和真实调参假设悄悄脱节。
 */
function readRealm(userMessage) {
  return extract(/当前阶位「([^」]+)」/, userMessage, REALMS[0]);
}

/** 模拟模型写剧情，但不预判由程序结算的突破结果。 */
function buildNarrative(seed) {
  return [
    pick(OPENINGS, seed),
    `你试着冲击眼前的瓶颈，结果仍要交给这段岁月检验。${pick(CLOSINGS, seed + 7)}`,
  ].join('');
}

/**
 * 本段的时间跨度（年）。
 *
 * 默认值刻意与 `pacing.timeAdvanceHint` 对青冥仙途的推导保持一致
 * （终局寿元 3400 ÷ 目标段数 60 ≈ 57 年封顶），这样模拟服务的节奏和真实
 * 调参假设吻合，端到端跑出来的段数才和 `npm test -- balance` 说的是同一件事。
 */
function timeAdvanceFor(realmIndex, seed) {
  if (state.advanceYears !== null) return state.advanceYears;

  const topStep = 57;
  const t = Math.min(1, Math.max(0, realmIndex / (REALMS.length - 1)));
  const curve = t * t;
  const min = Math.max(3, Math.round(3 + curve * (topStep - 3) * 0.4));
  const max = Math.max(min, Math.round(3 + curve * (topStep - 3)));
  return min + (seed % Math.max(1, max - min + 1));
}

/**
 * 造一段条目流。
 *
 * 条目年龄必须单调不减且落在段内——这是程序侧会校验的不变量，
 * 模拟服务要是自己先违反了，端到端测到的就是「规整层能不能兜住」，
 * 而不是「正常路径通不通」。
 */
function buildEntries(startAge, timeAdvance, callIndex) {
  const count = Math.max(4, Math.min(8, Math.round(timeAdvance / 2) + 3));
  const entries = [];

  for (let index = 0; index < count; index += 1) {
    const age = startAge + Math.round(((index + 1) / count) * timeAdvance);
    const kind = ENTRY_KIND_CYCLE[(index + callIndex) % ENTRY_KIND_CYCLE.length];
    entries.push({ age, kind, text: pick(ENTRY_TEXTS[kind] ?? ENTRY_TEXTS.event, callIndex + index) });
  }

  // 收尾放一条 milestone 并展开成完整叙事，好让年表上出现一个「重要时刻」。
  // detail 保持中性，突破结果由结算层写入年表。
  const last = entries[entries.length - 1];
  last.kind = 'milestone';
  last.text = ENTRY_TEXTS.milestone[0];

  return entries;
}

function buildSegmentResponse(userMessage, callIndex) {
  if (userMessage.includes('人物年龄、属性和关系只以')) {
    const startAge = Number(extract(/年龄：(\d+)\s*岁/, userMessage, '18'));
    const custom = userMessage.includes('荒原书屋');
    const star = userMessage.includes('殖民地阶段') || userMessage.includes('长夜号');
    const ashen = userMessage.includes('冒险者公会') || userMessage.includes('灰烬领');
    const entries = star ? [
      { age: startAge + 1, kind: 'event', text: '维修队更换了穹顶的循环泵，农场重新通上了水' },
      { age: startAge + 1, kind: 'relationship', text: '你和工程师林澈轮流值夜，把旧图纸重新整理了一遍' },
      { age: startAge + 2, kind: 'setback', text: '备用零件在沙尘里磨损，施工队不得不停工一周' },
      { age: startAge + 3, kind: 'milestone', text: '第一座新的生态仓完成验收，殖民地多了一份活下去的把握' },
    ] : ashen ? [
      { age: startAge + 1, kind: 'event', text: '你接下了裂谷边缘的护送委托，与三名同伴一同出发' },
      { age: startAge + 1, kind: 'relationship', text: '回程时你把受伤的队友背过山口，对方记下了这份情' },
      { age: startAge + 2, kind: 'setback', text: '你在一场遭遇战里扭伤了肩，休息了很长一段时间' },
      { age: startAge + 3, kind: 'milestone', text: '委托完成后，公会核对了证词和报酬，准备重新评定你' },
    ] : custom ? [
      { age: startAge + 1, kind: 'event', text: '邻居送来一捆干柴，你用修好的书架换下了一袋旧纸' },
      { age: startAge + 1, kind: 'relationship', text: '一个孩子每天来借书，你开始教她辨认地图上的地名' },
      { age: startAge + 2, kind: 'setback', text: '严冬让屋顶漏了雪，你和邻居花了两天才把它堵住' },
      { age: startAge + 3, kind: 'milestone', text: '你决定把图书馆开放的日子固定下来，让更多人能读书' },
    ] : [
      { age: startAge + 1, kind: 'event', text: '公司换了新的负责人，你接手了一项没人愿意碰的工作' },
      { age: startAge + 1, kind: 'relationship', text: '下班后你和旧友在街边小店谈到很晚，约好常联系' },
      { age: startAge + 2, kind: 'setback', text: '连续加班让你疲惫不堪，你终于请假去做了检查' },
      { age: startAge + 3, kind: 'milestone', text: '你决定重新安排工作与生活，把周末留给自己' },
    ];
    const mustStop = userMessage.includes('必须给出一个 decision');
    const payload = {
      entries,
      timeAdvance: 3,
      attributeDeltas: star ? { work: 3, health: -1, resolve: 2 }
        : ashen ? { exploits: 4, health: -1, rank: 1 }
          : { career: 3, health: -1, spirit: 2, wealth: 1 },
      ...(star ? { worldDeltas: { progress: 25, tech: 2, resources: -2 } } : {}),
      worldStatusUpdate: star
        ? `生态仓正在扩建，公共资源仍然紧张。（第 ${callIndex} 次推演）`
        : ashen
          ? `裂谷一带的委托仍在增加。（第 ${callIndex} 次推演）`
          : custom
        ? `图书馆依然开放，补给线路仍未恢复。（第 ${callIndex} 次推演）`
        : `这座城市的生活节奏仍在变化。（第 ${callIndex} 次推演）`,
    };
    if (state.proposeDecision || mustStop) {
      payload.decision = {
        prompt: '你收到一份新的工作邀请，同时家里也需要你留下照顾。',
        stakes: '收入、健康和亲近的人都可能因此改变。',
        options: ['接受邀请', '留在原处', '先和家人商量'],
      };
    }
    return payload;
  }
  const startAge = Number(extract(/年龄：(\d+)\s*岁/, userMessage, '16'));
  const realmIndex = Math.max(0, REALMS.indexOf(readRealm(userMessage)));

  const timeAdvance = timeAdvanceFor(realmIndex, callIndex);

  const entries = buildEntries(startAge, timeAdvance, callIndex);
  // 只有重要条目才给 detail——这是提示词里的要求，模拟服务也得守
  entries[entries.length - 1].detail = buildNarrative(callIndex);

  const deltas = {};
  if (callIndex % 2 === 0) deltas.comprehension = 2;
  if (callIndex % 3 === 0) deltas.willpower = 1;
  if (callIndex % 4 === 0) deltas.reputation = 3;
  if (callIndex % 5 === 0) deltas.luck = 1;
  if (callIndex % 3 === 1) deltas.willpower = -1;

  // 两种情况下给决策点：
  //   1. 控制接口打开了 proposeDecision（用来验证决策卡本身）
  //   2. 提示词里下了「本段必须给出一个 decision」的强制指令
  //
  // 第 2 条是在模拟一个**遵守指令的模型**——这才是产品设计所假设的正常情况。
  // 一个总是不给岔路的模型走的是降级路径（照常结算 + 记警告），那条路径由单测覆盖。
  const mustStop = userMessage.includes('必须给出一个 decision');
  const proposeDecision = state.proposeDecision || mustStop;

  if (proposeDecision) {
    // 同时把本段的属性变动做大，好让「变动幅度」这道门槛稳定命中。
    //
    // 端到端需要**确定性**：段号 1 的间隔只有 1 段，够不到关键词门槛（6 段），
    // 于是只能靠突破——而突破是 50% 的掷骰子，场景会一半概率失败。
    // 给一段明确的「大事」（总变动 ≥ 25）比等一次运气靠谱得多。
    deltas.comprehension = (deltas.comprehension ?? 0) + 12;
    deltas.reputation = (deltas.reputation ?? 0) + 10;
    deltas.luck = (deltas.luck ?? 0) + 6;
  }

  const payload = {
    entries,
    timeAdvance,
    attributeDeltas: deltas,
    worldStatusUpdate: `青冥山一带的灵气又薄了一分。（第 ${callIndex} 次推演）`,
    inventoryOps: callIndex % 6 === 0 ? [{ op: 'add', value: `旧物·${callIndex}` }] : [],
  };

  if (proposeDecision) {
    payload.decision = {
      prompt: '一位自称来自上宗的人找上门，说可以带你走。他的袖口绣着你没见过的纹样。',
      stakes: '无论怎么选，你都不会再回到从前的日子。',
      options: ['跟他走', '婉拒', '追问他的来历'],
    };
  }

  return payload;
}

function buildSummaryResponse(userMessage, callIndex) {
  const previous = /## 已有摘要\n([\s\S]*?)\n\n## 需要并入摘要的新段落/.exec(userMessage)?.[1] ?? '';
  const hasPrevious = previous.includes('暂无');

  return [
    hasPrevious
      ? '你自青冥山下一户人家醒来，此后一直在山中修炼。'
      : '你自青冥山下一户人家醒来，此后一直在山中修炼，期间偶有下山，见识过几桩人事。',
    `到目前为止，你的修为稳步积累，尚未遇到真正改变命运的机缘。（摘要第 ${callIndex} 版）`,
  ].join('');
}

function buildEpilogueResponse(userMessage) {
  const name = extract(/姓名：(.+)/, userMessage, '你');
  const age = extract(/享年：(\d+)\s*岁/, userMessage, '?');
  const reason = extract(/原因：(.+)/, userMessage, '寿元耗尽');

  return [
    `${name}这一生，起于青冥山下的一间旧屋，止于${reason}，享年 ${age} 岁。`,
    '你没有成为传说里那种人。多数时候你只是在修炼，在等待，在把一年又一年交出去。偶有几次你以为自己抓住了什么，后来发现那不过是时间开的玩笑。',
    '但你也确实走过了一段很长的路。你见过山上的雪，见过集市散场后的空街，见过一些人来了又走。这些东西没有写进任何典籍，却构成了你全部的一生。',
    '故事到这里就结束了。',
  ].join('\n\n');
}

/**
 * 自定义世界生成的模拟回复。
 *
 * 刻意返回一份**数值上不完美**的草稿（寿元阶梯偏扁平、有个属性引用写错），
 * 这样端到端验证才能覆盖到「程序修复」这一段，而不是只测了顺利路径。
 */
function buildForgeResponse(userMessage) {
  const premise = extract(/「([^」]*)」/, userMessage, '赛博朋克都市');

  return {
    name: '霓虹残响',
    description: `义体与数据流的年代。${premise}——你在这座城市的地下三层醒来，身上只有一副来路不明的义眼。`,
    initialWorldStatus: '城北的供电网第三次被切断，没人知道是谁干的，也没人敢问。',
    timeUnit: 'year',
    rules: [
      '义体可以替换肉体，但每换一次，你就少记得一点原来的自己。',
      '网络里的东西会咬人，断线不等于安全。',
      '公司控制着空气、水和电，反抗的代价通常由别人承担。',
      '数据不会消失，只会被藏起来。',
      '在这座城市里，活着的成本每周都在涨。',
    ],
    startingAge: 22,
    realmNames: ['野鼠', '接活人', '独行客', '代号者', '幽灵'],
    // 阶梯偏扁平，展开阶段会重塑；末阶跨度也偏大，用于触发校准
    lifespanByRealm: [56, 62, 70, 80, 220],
    attributes: [
      { key: 'rank', label: '声望等级', kind: 'counter', min: 0, max: 4, initialValue: 0, integer: true, primary: true },
      { key: 'trace', label: '踪迹', kind: 'progress', min: 0, max: 100, initialValue: 0, integer: true, primary: true },
      { key: 'reflex', label: '反应', kind: 'counter', min: 0, max: 100, initialValue: 50, integer: true, primary: true, roll: { min: 30, max: 70 } },
      { key: 'lucidity', label: '清明', kind: 'counter', min: 0, max: 100, initialValue: 55, integer: true, primary: true, roll: { min: 30, max: 75 } },
      { key: 'favor', label: '人情', kind: 'counter', min: 0, max: 100, initialValue: 40, integer: true, primary: true, roll: { min: 20, max: 70 } },
      { key: 'odds', label: '变数', kind: 'counter', min: 0, max: 100, initialValue: 50, integer: true, roll: { min: 20, max: 80 } },
      // 故意留一个不存在的引用，验证展开阶段能兜住
      { key: 'chrome', label: '义体', kind: 'resource', min: 0, initialValue: 0, integer: true, unit: '件' },
    ],
    mechanics: {
      cultivationKey: 'trace',
      realmKey: 'rank',
      cultivationMax: 100,
      aptitudeKey: 'reflex',
      // 故意写一个不存在的键，验证展开阶段能兜住并记录修正
      willpowerKey: 'sanity',
      luckKey: 'odds',
      weights: { reflex: 0.35, lucidity: 0.3, favor: 0.2, odds: 0.15 },
      lethalEventKeywords: ['致命', '濒死', '烧毁', '贯穿', '坠落', '断电'],
      completionProposalMinRealm: 3,
    },
    talents: [
      { name: '军用义眼', description: '能看见热源，也能看见别人看不见的东西。', attributeBonus: { reflex: 15, lucidity: -8 } },
      { name: '老关系', description: '地下三层有一半人欠过你。', attributeBonus: { favor: 20 } },
      { name: '空白档案', description: '公司系统里查不到你，这既是保护也是麻烦。', attributeBonus: { odds: 15, rank: -0 } },
      { name: '过度改装', description: '你的身体一半不是原装的，快，但不稳。', cultivationGainMul: 1.25, attributeBonus: { lucidity: -12 } },
      { name: '记性好', description: '你看过的东西不会忘，包括不该看的。', attributeBonus: { lucidity: 18 } },
      { name: '穷惯了', description: '你知道怎么用最少的钱撑过一个月。', cultivationGainMul: 1.1, attributeBonus: { favor: -8 } },
    ],
    endings: {
      lifespan: { reason: '义体衰竭（{realm}·{lifespan} 岁）', narrative: '身体里的零件比你先一步停工。{realm}的那些年像数据一样被清空，享年 {age} 岁。' },
      collapse: { reason: '清明耗尽', narrative: '你再也分不清哪些记忆是自己的。你走进雨里，没有回来，享年 {age} 岁。' },
      ascension: { reason: '你成了网络上的一段传说', narrative: '没有人再见过你，但每个角落都有你的痕迹。城市依旧，只是从此多了一个不能提的名字。' },
      turnLimit: { reason: '故事在此收束', narrative: '你的故事在此收束。享年 {age} 岁。' },
      deathByProposal: '{reason}。你的一生在此戛然而止，享年 {age} 岁。',
      completionByProposal: '{reason}。你的故事在此收束，享年 {age} 岁。',
    },
  };
}

function buildOpenForgeResponse(userMessage) {
  const premise = extract(/「([^」]*)」/, userMessage, '灾后图书馆');
  return {
    name: '荒原书屋',
    description: `灾后荒原上，${premise}。你守着一座还在开放的图书馆，与邻居一起熬过严冬。`,
    initialWorldStatus: '补给线路中断，读者与邻居为了取暖开始争执。',
    rules: ['食物要靠交换取得。', '严冬会损伤健康。', '图书馆的书无法重印。'],
    startingAge: 24,
    attributeLabels: {
      career: '守书', health: '体魄', insight: '学识', empathy: '人缘',
      fortune: '机运', spirit: '心气', wealth: '物资',
    },
    talents: [
      { name: '旧馆员', description: '记得每本书的位置。', bonusKey: 'insight', bonus: 12 },
      { name: '修理匠', description: '能修复破损的器具。', bonusKey: 'career', bonus: 10 },
      { name: '孤僻者', description: '习惯一个人工作。', bonusKey: 'empathy', bonus: -8 },
    ],
    lethalEventKeywords: ['重伤', '冻死', '濒死'],
    aging: false,
    worldResources: [
      { key: 'supplies', label: '公共补给', initialValue: 10, annualDelta: -5 },
      { key: 'archive', label: '馆藏完整度', initialValue: 30, annualDelta: 0 },
    ],
    objective: { scope: 'world', key: 'archive', threshold: 70, reason: '馆藏得以保存', narrative: '你在 {age} 岁见证了图书馆的延续。' },
    failure: { key: 'supplies', threshold: 0, reason: '公共补给耗尽', narrative: '补给耗尽，守护图书馆的计划在你 {age} 岁时失败。' },
  };
}

/**
 * AI 辅助决策的模拟回复。
 *
 * 选项列表在**系统提示**里（跟在「以下是可选的行动：」之后），不在玩家消息里。
 * 解析时要先切出那一段——世界法则本身也是「1. xxx」的编号格式，直接全文匹配会串。
 */
function buildSuggestPickResponse(systemMessage) {
  const block = systemMessage.split('以下是可选的行动：')[1]?.split('请选出')[0] ?? '';
  const options = [...block.matchAll(/^(\d+)\.\s*(.+)$/gm)].map((match) => ({
    index: Number(match[1]),
    text: match[2].trim(),
  }));

  // 刻意选第二个而不是第一个，好让端到端能确认「AI 的选择」被真的用上了
  const chosen = options[1] ?? options[0];
  return {
    index: chosen?.index ?? 0,
    reason: `以他这些年的性子，多半会选「${chosen?.text ?? '继续等待'}」。`,
  };
}

function buildSuggestWriteResponse() {
  return {
    action: '我决定沿着山道往下走，去最近的那处集市看看。',
    reason: '在山里待得太久，有些事必须到人堆里才问得清楚。',
  };
}

/**
 * Jev（System One 协议）打分端点的模拟回复。
 *
 * criteria 的键是选项序号（客户端的约定，见 src/lib/jev/client.ts），概率刻意让
 * 序号 1 的选项最高——与 suggest 模拟回复选第二个是同一个理由：端到端可以用
 * 它确认「分数最高的选项」被界面真的用上了，而不是碰巧显示了个数。
 */
function buildScoreResponse(payload) {
  const questions = typeof payload.questions === 'object' && payload.questions !== null
    ? payload.questions
    : {};
  const entry = Object.entries(questions).find(([, question]) => question?.type === 'choice');
  if (!entry) return null;

  const [key, question] = entry;
  const keys = Object.keys(question.criteria ?? {});
  if (keys.length === 0) return null;

  const weights = keys.map((_, index) => (index === 1 ? 2 : 1));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const probabilities = {};
  let topKey = keys[0];
  keys.forEach((keyOption, index) => {
    probabilities[keyOption] = weights[index] / total;
    if (probabilities[keyOption] > probabilities[topKey]) topKey = keyOption;
  });

  return {
    model: 'jev-mock-1.0',
    answers: {
      [key]: {
        type: 'choice',
        choice: topKey,
        probabilities,
        confidence: 0.82,
      },
    },
    usage: { input_tokens: JSON.stringify(payload).length, output_tokens: 8 },
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

let callIndex = 0;

const server = createServer(async (request, response) => {
  const corsHeaders = NO_CORS
    ? {}
    : {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400',
      };

  if (request.method === 'OPTIONS') {
    response.writeHead(NO_CORS ? 403 : 204, corsHeaders);
    response.end();
    return;
  }

  // 运行时控制接口，供端到端脚本切换场景
  if (request.url?.endsWith('/control')) {
    if (request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      response.end(JSON.stringify(state));
      return;
    }
    if (request.method === 'POST') {
      try {
        const patch = JSON.parse(await readBody(request));
        if (typeof patch.delayMs === 'number') state.delayMs = patch.delayMs;
        if (typeof patch.advanceYears === 'number') state.advanceYears = patch.advanceYears;
        if (patch.advanceYears === null) state.advanceYears = null;
        if (typeof patch.proposeDecision === 'boolean') state.proposeDecision = patch.proposeDecision;
        if (typeof patch.emptyWithLength === 'boolean') state.emptyWithLength = patch.emptyWithLength;
        if (typeof patch.jevFail === 'boolean') state.jevFail = patch.jevFail;
        if (typeof patch.resetCallIndex === 'boolean' && patch.resetCallIndex) callIndex = 0;
      } catch {
        // 忽略非法负载，保持原状态
      }
      response.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      response.end(JSON.stringify(state));
      return;
    }
  }

  // Jev 打分端点：与 /chat/completions 平行的另一条协议（System One）
  if (request.method === 'POST' && request.url?.endsWith('/v1/systemone')) {
    let payload;
    try {
      payload = JSON.parse(await readBody(request));
    } catch {
      response.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
      response.end(JSON.stringify({ error: { message: 'invalid json body' } }));
      return;
    }

    if (state.jevFail) {
      // 故障注入放在延迟之前：真实世界里的上游故障通常也是快速失败，
      // 降级路径的验证不应该被 delayMs 拖慢
      response.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
      response.end(JSON.stringify({ error: { message: 'injected jev failure' } }));
      return;
    }

    const score = buildScoreResponse(payload);
    if (!score) {
      response.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
      response.end(JSON.stringify({ error: { message: 'no choice question in request' } }));
      return;
    }

    if (state.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    }

    response.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    response.end(JSON.stringify(score));
    return;
  }

  if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
    response.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders });
    response.end(JSON.stringify({ error: { message: 'not found' } }));
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(request));
  } catch {
    response.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
    response.end(JSON.stringify({ error: { message: 'invalid json body' } }));
    return;
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const system = messages.find((message) => message.role === 'system')?.content ?? '';
  const user = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';

  callIndex += 1;

  let content;
  if (system.includes('长期记忆')) {
    content = buildSummaryResponse(user, callIndex);
  } else if (system.includes('生平总结')) {
    content = buildEpilogueResponse(user);
  } else if (system.includes('选择了「开放人生」')) {
    content = JSON.stringify(buildOpenForgeResponse(user));
  } else if (system.includes('世界观设计师')) {
    // 自定义世界生成：多一次模型往返、响应更长，延迟也拉长一些
    content = JSON.stringify(buildForgeResponse(user));
  } else if (system.includes('"index"')) {
    content = JSON.stringify(buildSuggestPickResponse(system));
  } else if (system.includes('"action"')) {
    content = JSON.stringify(buildSuggestWriteResponse());
  } else {
    // 认不出请求类型时**必须出声**。
    //
    // 这里曾经按提示词的措辞来分派（「玩家让你替他决定接下来做什么」），
    // 后来提示词改了说法，分派静默落到段落分支，端到端表现为「AI 建议没出来」，
    // 排查了很久才发现是模拟服务自己认错了请求。
    // 现在按**输出契约**分派（契约比措辞稳定得多），并且在兜底分支上校验一次。
    if (!user.includes('"entries"')) {
      console.warn(
        '[mock] 认不出这个请求，已按段落生成处理。system 提示开头：',
        system.slice(0, 160).replace(/\s+/g, ' '),
      );
    }

    // 段落生成：即使请求里带了 response_format，也照样可能被模型包进围栏，
    // 这里偶尔故意包一次，用来验证客户端的宽松解析确实生效。
    const json = JSON.stringify(buildSegmentResponse(user, callIndex));
    content = callIndex % 7 === 0 ? `\`\`\`json\n${json}\n\`\`\`` : json;
  }

  // 模拟真实网络延迟，好让「生成中 / 校验中 / 结算中」的阶段提示看得见；
  // 拉长后还能用来在「生成中」刷新页面，验证崩溃恢复。
  if (state.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, state.delayMs));
  }

  // 模拟「被输出上限截断」：内容为空、finish_reason 为 length。
  // 这是真实世界里最容易误判的一种失败——从响应体上完全看不出问题出在哪。
  const truncated = state.emptyWithLength;
  const finalContent = truncated ? '' : content;
  const finishReason = truncated ? 'length' : 'stop';

  response.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
  response.end(
    JSON.stringify({
      id: `mock-${callIndex}`,
      object: 'chat.completion',
      model: payload.model ?? 'mock',
      choices: [
        { index: 0, message: { role: 'assistant', content: finalContent }, finish_reason: finishReason },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
  );
});

server.listen(PORT, HOST, () => {
  console.log(`模拟模型服务已启动：http://${HOST}:${PORT}/v1`);
  console.log(`接口地址填：http://${HOST}:${PORT}/v1`);
  console.log(`Key 随便填，模型名填 mock${NO_CORS ? '（已关闭跨域支持）' : ''}`);
});
