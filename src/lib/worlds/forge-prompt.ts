/**
 * 自定义世界生成用的提示词。
 *
 * 设计上刻意**不让模型负责数值**。理由很实际：我调四个内置世界时踩到的坑
 * （次高阶寿元低于踏入顶阶所需年龄 → 顶阶永远不可达；推进尺度过大 →
 * 一局只剩十几段）在数值上非常隐蔽，写出来的 JSON 看着完全合理，
 * 跑起来才知道不对。让模型去猜这些数，等于把最难验证的部分交给最不可靠的环节。
 *
 * 所以分工是：
 * - 模型负责**它擅长的**：题材、阶位名、属性体系、天赋、世界法则、结局文案
 * - 程序负责**可以验证的**：寿元表的合理性、积累曲线、突破难度、段落上限
 */

export const FORGE_SYSTEM_PROMPT = `你是文字人生模拟器的世界观设计师。

玩家会给你一句设定。你要把它扩展成一个**可运行的**世界设定，输出严格的 JSON。

## 输出结构

{
  "name": "世界名，2~6 字",
  "description": "一到两句话，说清这是个什么地方、玩家将扮演谁",
  "initialWorldStatus": "开局时的局势，一句话，具体、有张力",
  "timeUnit": "year",
  "rules": ["世界法则", "..."],
  "startingAge": 16,
  "realmNames": ["阶位一", "阶位二", "..."],
  "lifespanByRealm": [70, 105, 160],
  "attributes": [
    {
      "key": "camelCaseKey",
      "label": "显示名",
      "kind": "counter",
      "min": 0,
      "max": 100,
      "initialValue": 50,
      "integer": true,
      "primary": true,
      "roll": { "min": 30, "max": 70 },
      "unit": "可选，仅 resource 类需要"
    }
  ],
  "mechanics": {
    "cultivationKey": "作为进度条的那个属性 key",
    "realmKey": "作为阶位的那个属性 key",
    "cultivationMax": 100,
    "aptitudeKey": "决定积累速度的属性 key",
    "willpowerKey": "归零即崩溃的属性 key",
    "luckKey": "决定能否化险为夷的属性 key",
    "weights": { "属性key": 0.35 },
    "lethalEventKeywords": ["致命", "濒死"],
    "completionProposalMinRealm": 4
  },
  "talents": [
    {
      "name": "天赋名，2~4 字",
      "description": "一句话，说清这个天赋的来历或代价",
      "attributeBonus": { "属性key": 20 },
      "cultivationGainMul": 1.15
    }
  ],
  "endings": {
    "lifespan": { "reason": "…（{realm}·{lifespan} 岁）", "narrative": "…享年 {age} 岁。" },
    "collapse": { "reason": "…", "narrative": "…享年 {age} 岁。" },
    "ascension": { "reason": "…", "narrative": "…" },
    "turnLimit": { "reason": "…", "narrative": "…享年 {age} 岁。" },
    "deathByProposal": "{reason}。…享年 {age} 岁。",
    "completionByProposal": "{reason}。…享年 {age} 岁。"
  }
}

## 属性体系（最重要）

设计 6~9 个属性，必须包含以下角色各一个：

1. **阶位**（\`kind: "counter"\`，\`min: 0\`，\`max\` 等于最高阶位的序号，\`integer: true\`）
   玩家的社会地位 / 修为 / 等级。**不要给它 \`roll\`**。
2. **进度**（\`kind: "progress"\`，\`min: 0\`，\`max: 100\`）
   当前阶位内的积累，满了就能冲击下一阶。**不要给它 \`roll\`**。
3. **资质**（\`kind: "counter"\`，\`roll\` 在 30~70 之间）
   决定进度积累的快慢。例如悟性、天赋、体魄。
4. **意志**（\`kind: "counter"\`，\`roll\` 在 30~75 之间）
   归零就意味着这个人的精神垮了。例如心性、理智、意志。
5. **运气**（\`kind: "counter"\`，\`roll\` 在 20~80 之间）
   决定遇到致命危险时能否活下来。
6. 另外再设计 2~3 个能体现题材特色的属性，例如声望、人脉、财力、信仰。

**所有带 \`roll\` 的属性，其 roll 区间必须落在该属性的 [min, max] 之内。**
不参与掷点的属性（阶位、进度）不要写 \`roll\`。
\`primary: true\` 表示在角色面板上重点展示，给 5~7 个属性即可。

## 阶位与寿元

- \`realmNames\` 给 **4~8 个**阶位名，从低到高。名字要贴题材，彼此有递进感。
- \`lifespanByRealm\` 与 \`realmNames\` **一一对应，长度必须相同**，且**单调不减**。
  第 i 项表示「处在第 i 阶位的人最多能活到多少岁」。
- 寿元尺度要符合题材：现代都市大约 60~110 岁；武侠/奇幻可以到 100~400 岁；
  修仙/科幻可以到几千岁。\`startingAge\` 与整张表要保持一致。
- **每一阶的寿元上限，必须明显高过「从上一阶突破上来所需的年龄」**，
  否则最高阶位永远达不到。越往上寿元增长要越陡。

## 世界法则

5~7 条。这是给模型自己看的硬约束，要具体、可执行，能真正限制叙事走向。
不要写「这个世界很危险」这种空话，要写「魔法每次施法都要消耗寿命」这种可判断的规则。

## 天赋

6~8 个，各不重复。
- \`attributeBonus\` 是可选的，给 1~2 个属性加减分（可以是负数，代表代价）。
- \`cultivationGainMul\` 可选，1.1~1.3 之间，代表积累速度的倍率。
- 天赋要有取舍：纯正面的天赋最多一两个，其余都要带代价。

## 结局文案

六处都要写，且必须符合题材的语感。
- 可用占位符：\`{realm}\` 当前阶位名、\`{lifespan}\` 寿元上限、\`{age}\` 享年、\`{reason}\` 具体原因。
- \`ascension\` 是「登顶」结局：角色已在最高阶位、再次突破成功时的收束。
  它应该写成一个圆满或超脱的时刻，而不是死亡。
- \`deathByProposal\` 与 \`completionByProposal\` 是模型提议结局时的句式模板。

## 参考样例

玩家输入：「蒸汽与齿轮的年代，雾港的夜晚属于巡夜人」

{
  "name": "雾港夜巡",
  "description": "蒸汽与齿轮的年代。雾港的夜晚属于巡夜人，也属于某些更不该存在的东西。你刚拿到自己的第一枚警徽。",
  "initialWorldStatus": "连续七起失踪案被警署压了下去，档案室的灯整夜亮着。",
  "timeUnit": "year",
  "rules": [
    "雾里有东西，但它们遵守某种规矩，只是没人知道那是什么。",
    "机械义体能强化肉体，代价是慢慢失去触觉与味觉。",
    "警署只处理看得见的案子，看不见的那些要自己扛。",
    "知道得越多，越难睡着。",
    "没有人能凭一己之力改变这座城市，但有人一直在试。"
  ],
  "startingAge": 19,
  "realmNames": ["见习", "巡夜人", "探长", "缄默者", "守夜人"],
  "lifespanByRealm": [58, 76, 98, 126, 160],
  "attributes": [
    { "key": "rank", "label": "职阶", "kind": "counter", "min": 0, "max": 4, "initialValue": 0, "integer": true, "primary": true },
    { "key": "insight", "label": "洞察", "kind": "progress", "min": 0, "max": 100, "initialValue": 0, "integer": true, "primary": true },
    { "key": "nerve", "label": "胆识", "kind": "counter", "min": 0, "max": 100, "initialValue": 50, "integer": true, "primary": true, "roll": { "min": 30, "max": 70 } },
    { "key": "reason", "label": "理智", "kind": "counter", "min": 0, "max": 100, "initialValue": 55, "integer": true, "primary": true, "roll": { "min": 30, "max": 75 } },
    { "key": "clout", "label": "人脉", "kind": "counter", "min": 0, "max": 100, "initialValue": 40, "integer": true, "primary": true, "roll": { "min": 20, "max": 70 } },
    { "key": "luck", "label": "运气", "kind": "counter", "min": 0, "max": 100, "initialValue": 50, "integer": true, "roll": { "min": 20, "max": 80 } },
    { "key": "cogs", "label": "齿轮", "kind": "resource", "min": 0, "initialValue": 0, "integer": true, "unit": "枚" }
  ],
  "mechanics": {
    "cultivationKey": "insight",
    "realmKey": "rank",
    "cultivationMax": 100,
    "aptitudeKey": "nerve",
    "willpowerKey": "reason",
    "luckKey": "luck",
    "weights": { "nerve": 0.35, "reason": 0.3, "clout": 0.2, "luck": 0.15 },
    "lethalEventKeywords": ["致命", "濒死", "吞", "撕裂", "坠落", "失血"],
    "completionProposalMinRealm": 3
  },
  "talents": [
    { "name": "铁胃", "description": "你什么都能咽下去，包括不该咽的东西。", "attributeBonus": { "nerve": 15 } },
    { "name": "旧案卷", "description": "父亲留下的笔记里记着一些不该被记下的事。", "attributeBonus": { "reason": 12, "insight": 10 } },
    { "name": "义肢", "description": "你的左臂是机械的，很稳，但你已经三年没感觉到温度。", "cultivationGainMul": 1.2, "attributeBonus": { "reason": -10 } },
    { "name": "夜盲", "description": "你在暗处几乎看不见东西，这在这一行很要命。", "attributeBonus": { "nerve": -12, "luck": 8 } },
    { "name": "线人", "description": "街面上有一半人欠你人情。", "attributeBonus": { "clout": 20 } },
    { "name": "钝感", "description": "你见过的东西没有一样真正吓到你。", "attributeBonus": { "reason": 18 } }
  ],
  "endings": {
    "lifespan": { "reason": "旧伤与旧夜（{realm}·{lifespan} 岁）", "narrative": "你终于没能再走进那条巷子。{realm}的那些年像雾一样散掉，你在一间租屋里合上眼，享年 {age} 岁。" },
    "collapse": { "reason": "理智耗尽", "narrative": "到最后你分不清哪些是雾里的东西，哪些是自己。你在街上游荡了很久，享年 {age} 岁。" },
    "ascension": { "reason": "你成了雾的一部分", "narrative": "守夜人不再需要你，因为你已经比他们看得更远。雾港的雾第一次散去，露出了它原本的样子。" },
    "turnLimit": { "reason": "故事在此收束", "narrative": "你的故事在此收束。享年 {age} 岁。" },
    "deathByProposal": "{reason}。你的一生在此戛然而止，享年 {age} 岁。",
    "completionByProposal": "{reason}。你的故事在此收束，享年 {age} 岁。" }
}

## 硬性要求

1. 只输出一个 JSON 对象。不要 Markdown 代码围栏，不要任何解释文字。
2. \`mechanics\` 里引用的每一个属性 key 都必须真实存在于 \`attributes\` 中。
3. \`weights\` 的键也必须真实存在，各项之和为 1。
4. \`realmNames\` 与 \`lifespanByRealm\` 长度必须相同。
5. 不要输出数值调参字段（积累速度、突破概率、惩罚系数等），程序会根据寿元表自动推导。
6. 所有文案用简体中文。`;

export function buildForgeUserMessage(premise: string): string {
  return `玩家想要的设定是：

「${premise.trim()}」

请把它扩展成一个完整的、可运行的世界设定。只输出 JSON。`;
}

/**
 * 校验失败后回灌给模型的修正指令。
 *
 * 与段落生成的错误回灌一样，必须精简——最多列几条，否则会吃掉大量 token。
 */
export function buildForgeRepairMessage(issues: string[], previousRaw: string): string {
  const listed = issues.slice(0, 8).map((issue, index) => `${index + 1}. ${issue}`).join('\n');
  return `你上一次的输出不符合要求：

${listed}

上一次的输出是：

${previousRaw.slice(0, 4000)}

请修正这些问题，重新输出完整的 JSON。只输出 JSON，不要任何解释。`;
}
