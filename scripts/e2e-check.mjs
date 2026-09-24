#!/usr/bin/env node
/**
 * 端到端冒烟验证。
 *
 * 用真实 Chromium 走完整流程，配合 `scripts/mock-model-server.mjs` 使用，
 * 不需要真实 API Key，也不消耗额度。
 *
 * 覆盖七个场景：
 *   main       配置接口 → 连通性自检 → 创角 → 连续推进 → 刷新持久化
 *              → 存档列表 → 导出 → 导入不覆盖 → 读取 IndexedDB 校验属性不变量
 *   open-life  新开《浮生记》→ 无默认世界 → 无阶位结算与文案 → 窄屏检查
 *   ending     快速推进到寿元耗尽 → 结局面板 → 生成生平总结 → 结束后拒绝继续推进
 *   recovery   生成中途刷新页面 → 出现「上次的生成没有完成」→ 重试该决定
 *   forge      一句话生成自定义世界 → 预览与修正说明 → 用它真的玩一局 → 刷新后仍在
 *   truncation 复现「空内容 + finish_reason: length」→ 自检不误判 → 段落给出可操作提示
 *   controls   年表 ↔ 事件流切换、连续推进中途暂停、暂停后仍能继续推进
 *   jev        决策卡的推演打分：配置 Jev → 分数与置信度出现 → 落库 →
 *              jevFail 注入后决策卡照常可用（降级）
 *
 * 依赖：playwright-core（刻意不作为项目依赖，避免为一次验证拖进整套浏览器工具链）。
 * 运行前先起好两个服务：
 *   npm run mock:model
 *   npm run build && npm run serve:static
 *
 * 用法：
 *   PLAYWRIGHT_CORE=<playwright-core 入口文件> [CHROME_PATH=<chromium 可执行文件>] \
 *     node scripts/e2e-check.mjs [--base-url http://127.0.0.1:3000] \
 *                                [--mock-url http://127.0.0.1:8787] \
 *                                [--shots /tmp/newlife-e2e] \
 *                                [--only main|open-life|worlds-open|ending|recovery|forge|forge-open|truncation|controls|jev]
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const playwrightEntry = process.env.PLAYWRIGHT_CORE;
const { chromium } = playwrightEntry
  ? await import(pathToFileURL(playwrightEntry).href)
  : await import('playwright-core');

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const BASE_URL = argValue('--base-url', 'http://127.0.0.1:3000');
const MOCK_URL = argValue('--mock-url', 'http://127.0.0.1:8787');
const SHOT_DIR = argValue('--shots', '/tmp/newlife-e2e');
const ONLY = argValue('--only', '');

const steps = [];
function record(name, ok, detail = '') {
  steps.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 切换模拟模型服务的运行时行为。 */
async function setMockState(patch) {
  const response = await fetch(`${MOCK_URL}/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(`控制接口返回 ${response.status}`);
  return response.json();
}

async function launchBrowser() {
  const attempts = [];
  if (process.env.CHROME_PATH) attempts.push({ executablePath: process.env.CHROME_PATH });
  attempts.push({ channel: 'chrome' });
  attempts.push({});

  let lastError;
  for (const options of attempts) {
    try {
      return await chromium.launch({ headless: true, ...options });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * 把模拟服务恢复到默认行为。
 *
 * **场景之间必须重置**：模拟服务的状态是进程级的，前一个场景留下的
 * `proposeDecision` / `advanceYears` 会悄悄改变后一个场景的节奏，
 * 让失败看起来像是应用的问题。这条是踩过一次才补上的。
 */
async function resetMockState() {
  await setMockState({
    delayMs: 350,
    advanceYears: null,
    proposeDecision: false,
    emptyWithLength: false,
    resetCallIndex: true,
  });
}

/** 配置好模型接口。三个场景都从这里开始。 */
async function configureModel(page) {
  await resetMockState();

  await page.goto(`${BASE_URL}/settings`, { waitUntil: 'load' });
  await page.locator('#baseUrl').waitFor({ state: 'visible' });
  await page.waitForTimeout(400);

  await page.fill('#baseUrl', `${MOCK_URL}/v1`);
  await page.fill('#model', 'mock');
  await page.fill('#apiKey', 'mock-key');

  await page.getByRole('button', { name: '测试连接' }).click();
  await page.getByText(/连接正常/).waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: '保存配置' }).click();
  await page.getByText('已保存', { exact: true }).first().waitFor({ timeout: 5000 });
}

/** 配置好 Jev 推演。紧跟 configureModel 之后调用（此时已在设置页）。 */
async function configureJev(page) {
  await page.locator('#jevBaseUrl').waitFor({ state: 'visible' });

  // 打分端点与主模型共用同一个 mock 服务：路径不同（/v1/systemone），协议不同
  await page.fill('#jevBaseUrl', MOCK_URL);
  await page.fill('#jevApiKey', 'mock-jev-key');

  await page.getByRole('button', { name: '测试推演' }).click();
  await page.getByText(/推演通道正常/).waitFor({ timeout: 20000 });

  await page.getByRole('button', { name: '保存推演配置' }).click();
  await page.getByText('已保存', { exact: true }).first().waitFor({ timeout: 5000 });
  record('Jev 推演：设置页连通并保存', true);
}

/** 校验创角页列出了全部内置世界观，并且切换后属性与天赋会同步更新。 */
async function checkWorldPicker(page) {
  await page.goto(`${BASE_URL}/new`, { waitUntil: 'load' });
  await page.getByRole('button', { name: /青冥仙途/ }).first().waitFor({ timeout: 15000 });

  const expected = ['青冥仙途', '浮生记', '灰烬王座', '星海孤舟'];
  const missing = [];
  for (const name of expected) {
    if ((await page.getByText(name, { exact: true }).count()) === 0) missing.push(name);
  }
  record(
    '创角页：列出全部内置世界观',
    missing.length === 0,
    missing.length > 0 ? `缺少 ${missing.join('、')}` : expected.join('、'),
  );

  await page.getByRole('button', { name: /青冥仙途/ }).first().click();
  await page.getByRole('button', { name: /剑骨天成/ }).waitFor({ timeout: 10000 });

  // 切到现代都市题材，确认属性与天赋跟着换了一整套
  await page.getByRole('button', { name: /浮生记/ }).first().click();
  await page.getByRole('button', { name: /书香门第/ }).waitFor({ timeout: 10000 });
  const switched =
    (await page.getByText('书香门第').count()) > 0 &&
    (await page.getByRole('button', { name: /剑骨天成/ }).count()) === 0;
  record('创角页：切换世界观后属性与天赋整体替换', switched);

  // 把世界观选择区拍下来，这是「支持多个题材」最直观的证据
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOT_DIR, '08-worlds.png') });

  // 切回修仙，后续流程沿用
  await page.getByRole('button', { name: /青冥仙途/ }).first().click();
  await page.getByRole('button', { name: /剑骨天成/ }).waitFor({ timeout: 10000 });
}

async function createCharacter(page, name, options = {}) {
  await page.goto(`${BASE_URL}/new`, { waitUntil: 'load' });
  await page.getByRole('button', { name: /青冥仙途/ }).first().click();
  await page.locator('#name').waitFor({ state: 'visible' });
  await page.fill('#name', name);
  await page.getByRole('button', { name: /剑骨天成/ }).click();

  if (options.screenshotPath) {
    // 掷点是在挂载后的 effect 里完成的，等它真的掷出来再截图，
    // 否则会拍到「正在掷点…」的占位。
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('重掷'),
      );
      return button !== undefined && !button.disabled;
    });
    await page.waitForTimeout(250);
    await page.screenshot({ path: options.screenshotPath });
  }

  await page.getByRole('button', { name: '开始这一生' }).click();
  await page.waitForURL(/\/play\/?\?save=/, { timeout: 20000 });
}

/**
 * 年表上已经落定了几段。
 *
 * 段落本身没有可读的编号文本（编号对玩家没有意义），因此界面给每个段落打了
 * `data-segment-id`，端到端脚本按它来等待推进落定。
 */
async function segmentCount(page) {
  return page.locator('[data-segment-id]').count();
}

async function waitForSegments(page, expected, timeout = 60000) {
  await page.waitForFunction(
    (target) => document.querySelectorAll('[data-segment-id]').length >= target,
    expected,
    { timeout },
  );
}

/**
 * 等界面回到「可以点」的状态。
 *
 * 段落一落盘，年表与决策卡就会渲染出来，但推进管线还在收尾（阶段提示没清、
 * 内存维护在跑），此刻按钮是禁用的。脚本如果立刻去点，会撞上一个短暂禁用、
 * 甚至正在被 React 换掉的元素——表现为「等了 30 秒还是 disabled」。
 *
 * 所以每一次操作之前都先等一个明确的「空闲」信号，而不是靠固定 sleep 猜。
 */
async function waitForIdle(page, timeout = 300000) {
  await page.waitForFunction(
    () => {
      const button = (label) =>
        [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

      // 停在决策卡上：以选项按钮为准
      const option = document.querySelector('[data-decision-option]');
      if (option) return !option.disabled;

      // 连续推进中会有「暂停」，此时什么都别点
      if (button('暂停')) return false;

      const batch = button('连续推进 ×5');
      if (batch) return !batch.disabled;

      // 已经收束：没有推进控制可点，交给调用方处理
      return true;
    },
    undefined,
    { timeout },
  );
}

/**
 * 往前推一段，等它真的落定。
 *
 * 遇到决策卡就先选第一个选项——决策卡会顶掉推进控制，只点「继续」会卡死。
 * 等待条件同时接受「新段出现」与「出现结局」两种结果，因为推进本来就可能直接收束故事。
 */
async function advance(page, times = 1) {
  for (let index = 0; index < times; index += 1) {
    await waitForIdle(page);

    const options = page.locator('[data-decision-option]');
    const answeringDecision = (await options.count()) > 0;
    const continueButton = page.getByRole('button', { name: '继续', exact: true });

    // 与 advanceBatch 同样的兜底：既没有岔路卡片也没有推进控制，说明已经收束。
    // 判断「还有没有可点的东西」比判断「有没有结束文案」可靠——结局面板会晚一帧。
    if (!answeringDecision && (await continueButton.count()) === 0) return true;

    const before = await segmentCount(page);

    let answeredDecision = false;
    if (answeringDecision) {
      answeredDecision = await options
        .first()
        .click({ timeout: 5000 })
        .then(() => true)
        .catch(() => false);
    }
    if (!answeredDecision) {
      const continueNow = page.getByRole('button', { name: '继续', exact: true });
      if ((await continueNow.count()) > 0) await continueNow.click();
      else return true; // 卡被换下后连「继续」都没了：故事已经收束
    }

    await page.waitForFunction(
      (target) => {
        const grown = document.querySelectorAll('[data-segment-id]').length >= target;
        const text = document.body.innerText;
        return grown || text.includes('此生终了') || text.includes('故事收束');
      },
      before + 1,
      { timeout: 60000 },
    );

    const ended =
      (await page.getByText('此生终了').count()) > 0 ||
      (await page.getByText('故事收束').count()) > 0;
    if (ended) return true;
  }
  return false;
}

/**
 * 往前推一批，等这一批真的跑完。
 *
 * 两条路径的等待目标不一样，**不能都按「段数 +1」等**：
 * - 答一张决策卡只推进一段
 * - 点「连续推进」要等整批（否则下一轮会在批次还在跑的时候去点按钮，
 *   而那一刻按钮是禁用的）
 *
 * 两种情况都可能被岔路或结局提前打断，所以等待条件要把它们也算上。
 */
async function advanceBatch(page, batchSize = 5) {
  await waitForIdle(page);

  const options = page.locator('[data-decision-option]');
  const answeringDecision = (await options.count()) > 0;
  const batchButton = page.getByRole('button', { name: `连续推进 ×${batchSize}` });

  // 既没有岔路卡片、也没有推进控制 → 故事已经收束。
  //
  // 这个兜底是必须的：**结局面板的渲染可能比段数增长晚一帧**，
  // 于是上一轮结尾读到的还是「没结束」，下一轮就点不到按钮了（实测卡在这里）。
  // 判断「还有没有可点的东西」比判断「有没有结束文案」可靠。
  if (!answeringDecision && (await batchButton.count()) === 0) return true;

  const before = await segmentCount(page);

  // 决策卡可能在「计数」与「点击」两帧之间被换下——上一批的收尾结算
  // （摘要回填、结局提交）会触发存档重渲染。所以点击用短超时，
  // 失败就重读现场，**按重读到的状态决定等待目标**：
  // 答卡 → +1；点推进 → 按实际点的算；什么都不剩 → 真收束了。
  let answeredDecision = false;
  if (answeringDecision) {
    answeredDecision = await options
      .first()
      .click({ timeout: 5000 })
      .then(() => true)
      .catch(() => false);
  }

  let target = before + 1;
  if (!answeredDecision) {
    const continueNow = page.getByRole('button', { name: '继续', exact: true });
    const batchNow = page.getByRole('button', { name: `连续推进 ×${batchSize}` });
    if ((await continueNow.count()) > 0) {
      await continueNow.click();
      target = before + 1;
    } else if ((await batchNow.count()) > 0) {
      await batchNow.click();
      target = before + batchSize;
    } else {
      // 没有岔路卡也没有推进控制：故事已经收束，结局文本马上会渲染出来
      target = before;
    }
  }

  try {
    await page.waitForFunction(
      (expected) => {
        const grown = document.querySelectorAll('[data-segment-id]').length >= expected;
        const text = document.body.innerText;
        return (
          grown ||
          text.includes('此生终了') ||
          text.includes('故事收束') ||
          text.includes('这是个岔路')
        );
      },
      target,
      { timeout: 300000 },
    );
  } catch (error) {
    // 等不到就带着现场走：没有快照与页面文本的 300s 超时是没法排查的
    await page.screenshot({ path: path.join(SHOT_DIR, 'stall-advance-batch.png'), fullPage: true });
    const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 500));
    console.error(`\n[诊断] advanceBatch 等待超时（target=${target}）。页面文本：${text}`);
    throw error;
  }

  return (
    (await page.getByText('此生终了').count()) > 0 ||
    (await page.getByText('故事收束').count()) > 0
  );
}

// ────────────────────────────────────────────────────────────
// 场景一：主流程
// ────────────────────────────────────────────────────────────

async function scenarioMain(page, consoleErrors) {
  // 首页列出全部内置世界，先拍一张
  await page.goto(`${BASE_URL}/`, { waitUntil: 'load' });
  await page.getByText('内置世界').waitFor({ timeout: 15000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOT_DIR, '00-home.png'), fullPage: true });

  await configureModel(page);
  record('设置页：连通性自检通过（浏览器直连 OpenAI 兼容端点）', true);

  await page.screenshot({ path: path.join(SHOT_DIR, '01-settings.png') });

  await checkWorldPicker(page);

  await createCharacter(page, '林砚', {
    screenshotPath: path.join(SHOT_DIR, '02-create.png'),
  });
  record('创角：角色创建成功并进入对局页', true);

  await page.getByRole('button', { name: '开始这一生' }).click();
  await waitForSegments(page, 1);
  record('对局：第一段生成成功，条目出现在年表上', true);

  const endedEarly = await advance(page, 4);
  record('对局：连续推进 4 段成功', !endedEarly);

  await page.screenshot({ path: path.join(SHOT_DIR, '03-play.png'), fullPage: true });

  // 年表视图的核心承诺：一屏能看到若干年，而不是一段长文。
  // 用 data-year-header 定位而不是文本「N 岁」——条目行里的年龄标签文本也是「N 岁」，
  // 用文本定位会把条目数当成年份分组数，断言就废了。
  const yearHeaders = await page.locator('[data-year-header]').count();
  record(
    '年表：条目按年份分组',
    yearHeaders >= 3,
    `可见 ${yearHeaders} 个年份分组`,
  );

  // 等侧栏真正把年龄渲染出来再读。`innerText` 依赖布局，
  // 而上一句的等待条件可能在布局完成前就成立了，直接读会偶发拿到旧内容。
  await page
    .waitForFunction(
      () => {
        const aside = document.querySelector('aside');
        return aside !== null && /\d+\s*岁/.test(aside.innerText);
      },
      undefined,
      { timeout: 10000 },
    )
    .catch(() => {});

  const sidebarText = await page.locator('aside').first().innerText();
  const hasAge = /\d+ 岁/.test(sidebarText);
  const hasRealm = /(凡人|炼气|筑基|金丹)/.test(sidebarText);
  record(
    '状态面板：显示年龄与阶位',
    hasAge && hasRealm,
    hasAge && hasRealm ? '' : `年龄=${hasAge} 阶位=${hasRealm}｜${sidebarText.slice(0, 80)}`,
  );

  // 直接从 IndexedDB 读回落盘状态，校验结算层的不变量。
  // 数值超界在界面上看不出来——只会安静地显示成一个奇怪的数字。
  const violations = await page.evaluate(async () => {
    const openRequest = indexedDB.open('newlife');
    const db = await new Promise((resolve, reject) => {
      openRequest.onsuccess = () => resolve(openRequest.result);
      openRequest.onerror = () => reject(openRequest.error);
    });
    const saves = await new Promise((resolve, reject) => {
      const store = db.transaction('saves', 'readonly').objectStore('saves');
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();

    const problems = [];
    for (const save of saves) {
      const definitions = new Map(save.world.attributes.map((a) => [a.key, a]));
      for (const [key, value] of Object.entries(save.character.attributes)) {
        const definition = definitions.get(key);
        if (!definition) {
          problems.push(`出现了未定义的属性键「${key}」`);
          continue;
        }
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          problems.push(`${definition.label} 不是有限数值：${value}`);
          continue;
        }
        if (definition.min !== undefined && value < definition.min) {
          problems.push(`${definition.label}=${value} 低于下限 ${definition.min}`);
        }
        if (definition.max !== undefined && value > definition.max) {
          problems.push(`${definition.label}=${value} 高于上限 ${definition.max}`);
        }
      }
    }
    return problems;
  });

  record(
    '状态不变量：落盘的属性全部落在合法区间内',
    violations.length === 0,
    violations.slice(0, 3).join('；'),
  );

  await page.reload({ waitUntil: 'load' });
  await waitForSegments(page, 5, 20000);
  record('持久化：刷新后年表与状态完整恢复', true);

  await page.goto(`${BASE_URL}/saves`, { waitUntil: 'load' });
  await page.getByText('林砚').first().waitFor({ timeout: 15000 });
  record('存档页：存档出现在列表中', true);

  const download = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.getByRole('button', { name: '导出' }).first().click(),
  ]).then(([item]) => item);

  const exportPath = path.join(SHOT_DIR, 'export.json');
  await download.saveAs(exportPath);
  record('存档页：导出 JSON 成功', true, download.suggestedFilename());

  await page.screenshot({ path: path.join(SHOT_DIR, '04-saves.png') });

  await page.locator('input[type=file]').setInputFiles(exportPath);
  await page.getByText(/导入成功/).waitFor({ timeout: 15000 });
  const cards = await page.getByText('林砚').count();
  record('存档页：导入成功且未覆盖原存档', cards >= 2, `列表中现有 ${cards} 份`);

  record(
    '主流程无控制台错误',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 2).join(' | '),
  );
}

/** 新规则的真实浏览器流程：现代人生不再显示或结算阶位寿元。 */
async function scenarioOpenLife(page, consoleErrors) {
  await configureModel(page);
  await page.goto(`${BASE_URL}/new`, { waitUntil: 'load' });
  const noDefault = (await page.locator('#name').count()) === 0;
  record('创角：初始不预选修仙世界', noDefault);

  await page.getByRole('button', { name: /浮生记/ }).first().click();
  await page.locator('#name').waitFor({ state: 'visible' });
  await page.fill('#name', '阿遥');
  await page.getByRole('button', { name: /书香门第/ }).click();
  await page.getByRole('button', { name: '开始这一生' }).click();
  await page.waitForURL(/\/play\/?\?save=/, { timeout: 20000 });
  await page.getByRole('button', { name: '开始这一生' }).click();
  await waitForSegments(page, 1);
  await waitForIdle(page);

  const aside = await page.locator('aside').first().innerText();
  const timeline = await page.locator('[data-segment-id]').first().innerText();
  record(
    '浮生记：状态只展示健康、事业与人生年龄',
    aside.includes('体魄') && aside.includes('事业') && !aside.includes('寿元') && !aside.includes('阶位'),
    aside.replace(/\s+/g, ' ').slice(0, 100),
  );
  record('浮生记：年表没有修行晋阶措辞', !timeline.includes('修行') && !timeline.includes('阶位'));

  const saved = await page.evaluate(async () => {
    const request = indexedDB.open('newlife');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const all = await new Promise((resolve, reject) => {
      const get = db.transaction('saves', 'readonly').objectStore('saves').getAll();
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    });
    db.close();
    return all.find((save) => save.character.name === '阿遥');
  });
  record(
    '浮生记：落盘使用新规则，事业变化但阶层不自动晋升',
    saved?.rulesetVersion === 2 && saved?.world.ruleset?.kind === 'open_life' &&
      saved?.character.attributes.career > 0 && saved?.character.attributes.stratum === undefined,
  );

  await page.screenshot({ path: path.join(SHOT_DIR, '12-open-life.png'), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const mobileFits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  record('浮生记：窄屏与减少动态效果下没有横向溢出', mobileFits);
  await page.screenshot({ path: path.join(SHOT_DIR, '13-open-life-mobile.png'), fullPage: true });
  record('浮生记流程无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
}

// ────────────────────────────────────────────────────────────
// 场景二：玩到结局并生成生平总结
// ────────────────────────────────────────────────────────────

async function scenarioEnding(page, consoleErrors) {
  await configureModel(page);
  await createCharacter(page, '终局者');

  await page.getByRole('button', { name: '开始这一生' }).click();
  await waitForSegments(page, 1);

  // 让模拟模型一次推进 60 年（规整层的上限）。
  //
  // 边界按**段数**给而不是按批数：强制停车会在年表中间插进决策卡，
  // 每答一次决策就消耗一次循环，按批数计会提前退出。
  //
  // 上界给到 70 段是因为突破会延长寿元，一路突破到高阶之后剩余寿元可能还有上千年，
  // 而单段跨度被规整层封在 60 年以内——这是设计使然，不是异常。
  // 这里刻意不预设死因，本场景要验证的是**结局流程本身**
  // （结局面板 → 生平总结 → 拒绝继续推进 → 存档标记已结束）。
  //
  // guard 给 60：终局阶段寿元进入末段后，每段都会因 near-end 停车给一次岔路，
  // 每答一次只推进一段——40 次迭代在坏的 RNG 轨迹下会先耗尽（实测 41 段未终局）。
  await setMockState({ advanceYears: 60 });

  let ended = false;
  let guard = 0;
  while (!ended && (await segmentCount(page)) < 70 && guard < 60) {
    ended = await advanceBatch(page);
    guard += 1;
  }

  const totalSegments = await segmentCount(page);
  record('结局：推进到终局', ended, ended ? `共 ${totalSegments} 段` : `${totalSegments} 段内未结束`);
  if (!ended) {
    await setMockState({ advanceYears: null });
    return;
  }

  await page.screenshot({ path: path.join(SHOT_DIR, '05-ending.png'), fullPage: true });

  // 结束后推进控制必须被替换掉，不能还能继续推进
  const endedPanel = await page.getByText('故事已结束').count();
  record('结局：推进控制提示故事已结束，无法继续推进', endedPanel > 0);

  // 生成生平总结
  await page.getByRole('button', { name: '生成生平总结' }).click();
  await page.getByText('故事到这里就结束了').waitFor({ timeout: 40000 });
  record('结局：生平总结生成成功', true);
  await page.screenshot({ path: path.join(SHOT_DIR, '06-epilogue.png'), fullPage: true });

  // 存档列表应显示为已结束
  // 存档列表要等 IndexedDB 读完才渲染，先等角色名出现再断言状态标签
  await page.goto(`${BASE_URL}/saves`, { waitUntil: 'load' });
  await page.getByText('终局者').first().waitFor({ timeout: 15000 });
  const endedBadges = await page.getByText('已结束').count();
  record('结局：存档列表中标记为已结束', endedBadges > 0);

  record(
    '结局流程无控制台错误',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 2).join(' | '),
  );

  await setMockState({ advanceYears: null });
}

// ────────────────────────────────────────────────────────────
// 场景三：生成中途刷新后的恢复
// ────────────────────────────────────────────────────────────

async function scenarioRecovery(page, consoleErrors) {
  await configureModel(page);

  // 大步推进 + 每段都提岔路：第一段就会因为突破而停车，得到一张决策卡
  await setMockState({ advanceYears: 12, proposeDecision: true });
  await createCharacter(page, '中断者');

  await page.getByRole('button', { name: '开始这一生' }).click();
  await waitForSegments(page, 1);
  await page.getByText('这是个岔路').waitFor({ timeout: 40000 });
  await waitForIdle(page);
  record('崩溃恢复：先推进到一张决策卡', true);

  // 把响应拖慢，好在「生成中」的时候刷新页面
  await setMockState({ delayMs: 8000 });

  // 点掉一个选项但**不等结果**——请求还在飞的时候直接刷新。
  // pending 记录是在发请求之前落盘的，所以刷新后应该能发现它。
  await waitForIdle(page);
  await page.getByRole('button', { name: '跟他走' }).first().click();
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: 'load' });

  const notice = page.getByText('上次的生成没有完成');
  await notice.waitFor({ timeout: 20000 });
  record('崩溃恢复：刷新后提示上一段未完成', true);

  // 断言必须**限定在提示框内部**：刷新后决策卡也在页面上，
  // 而它的选项按钮文案就是「跟他走」——全文匹配的话，提示框即使一个字都没写
  // 也会通过。这类「数到别的东西」的断言比没有断言更危险。
  const noticeSection = page.locator('section').filter({ hasText: '上次的生成没有完成' });
  const mentionsAction = await noticeSection.getByText(/跟他走/).count();
  record(
    '崩溃恢复：提示里带上了当时提交的决定',
    mentionsAction > 0,
    mentionsAction > 0 ? '' : '提示框内没有出现「跟他走」',
  );

  await page.screenshot({ path: path.join(SHOT_DIR, '07-recovery.png'), fullPage: true });

  // 恢复原速后点「重试这次推进」，应当真的补上这一段
  await setMockState({ delayMs: 350 });
  await page.getByRole('button', { name: '重试这次推进' }).click();
  await waitForSegments(page, 2);
  record('崩溃恢复：重试后这一段被正确补上', true);

  const stillPending = await page.getByText('上次的生成没有完成').count();
  record('崩溃恢复：重试成功后提示消失', stillPending === 0);

  record(
    '崩溃恢复流程无控制台错误',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 2).join(' | '),
  );

  await setMockState({ advanceYears: null, proposeDecision: false });
}

// ────────────────────────────────────────────────────────────
// 场景四：用一句话生成自定义世界，并真的用它玩一局
// ────────────────────────────────────────────────────────────

async function scenarioForge(page, consoleErrors) {
  await configureModel(page);

  await page.goto(`${BASE_URL}/new`, { waitUntil: 'load' });
  await page.getByRole('button', { name: '＋ 创建世界' }).click();
  await page.getByRole('button', { name: '阶位成长' }).click();

  await page.getByPlaceholder(/蒸汽与齿轮的年代/).fill('赛博朋克都市里的义体侦探');
  await page.getByRole('button', { name: '生成世界' }).click();

  // 生成要跑一次模型调用 + 数值校准，给足时间
  await page.getByText('霓虹残响').first().waitFor({ timeout: 120000 });
  record('生成世界：模型产出的世界出现在预览里', true);

  const hasTiers = (await page.getByText('幽灵').count()) > 0;
  const hasPacing = (await page.getByText(/平均一局 \d+ 段/).count()) > 0;
  record('生成世界：展示阶位体系与数值校准结果', hasTiers && hasPacing);

  // 模拟服务故意返回了跨度过大的寿元表和写错的属性引用，程序应当如实报告修正
  const hasNotes = (await page.getByText('程序做过的修正').count()) > 0;
  record('生成世界：如实展示程序做过的修正', hasNotes);

  await page.screenshot({ path: path.join(SHOT_DIR, '09-forge.png'), fullPage: true });

  await page.getByRole('button', { name: '用这个世界开始' }).click();
  const marked = (await page.getByText('自定义').count()) > 0;
  record('生成世界：生成后自动选中并标记为自定义', marked);

  // 创角面板必须立刻切到自定义世界的属性与天赋，
  // 否则玩家会看着上一个世界的数值做选择。
  await page.getByText('反应', { exact: true }).first().waitFor({ timeout: 10000 });
  const switched =
    (await page.getByText('清明', { exact: true }).count()) > 0 &&
    (await page.getByText('剑骨天成').count()) === 0;
  record('生成世界：创角面板切到自定义世界的属性与天赋', switched);
  await page.screenshot({ path: path.join(SHOT_DIR, '10-forged-selected.png') });

  // 关键一步：用自定义世界真的玩一局，确认它走的是同一条结算路径
  await page.fill('#name', '零');
  await page.getByRole('button', { name: '开始这一生' }).click();
  await page.waitForURL(/\/play\/?\?save=/, { timeout: 20000 });
  await page.getByRole('button', { name: '开始这一生' }).click();
  await waitForSegments(page, 1);
  record('生成世界：用自定义世界推进段落成功', true);

  // innerText 依赖布局，等待条件成立不代表布局已完成，先等属性真的渲染出来
  await page
    .waitForFunction(
      () => {
        const aside = document.querySelector('aside');
        return aside !== null && aside.innerText.includes('踪迹');
      },
      undefined,
      { timeout: 15000 },
    )
    .catch(() => {});

  const sidebar = await page.locator('aside').first().innerText();
  record(
    '生成世界：状态面板使用自定义世界的属性',
    sidebar.includes('踪迹') && sidebar.includes('清明'),
    sidebar.replace(/\s+/g, ' ').slice(0, 80),
  );

  // 自定义世界存在 IndexedDB 里，刷新后应当仍在
  await page.goto(`${BASE_URL}/new`, { waitUntil: 'load' });
  await page.getByText('霓虹残响').first().waitFor({ timeout: 20000 });
  record('生成世界：刷新后自定义世界仍然存在', true);

  record(
    '生成世界流程无控制台错误',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 2).join(' | '),
  );
}

async function scenarioOpenForge(page, consoleErrors) {
  await configureModel(page);
  await page.goto(`${BASE_URL}/new`, { waitUntil: 'load' });
  await page.getByRole('button', { name: '＋ 创建世界' }).click();
  record('开放工坊：默认选择开放人生', await page.getByRole('button', { name: '开放人生' }).getAttribute('aria-pressed') === 'true');
  await page.getByPlaceholder(/灾后荒原上/).fill('灾后荒原里守着一座图书馆的人');
  await page.getByRole('button', { name: '生成世界' }).click();
  await page.getByText('荒原书屋').first().waitFor({ timeout: 120000 });
  const preview = await page.locator('main').innerText();
  record('开放工坊：预览没有阶位与寿元表', preview.includes('规则检查') && !preview.includes('阶位体系') && !preview.includes('寿元上限'));
  await page.screenshot({ path: path.join(SHOT_DIR, '14-open-forge.png'), fullPage: true });
  await page.getByRole('button', { name: '用这个世界开始' }).click();
  await page.fill('#name', '阿宁');
  await page.getByRole('button', { name: '开始这一生' }).click();
  await page.waitForURL(/\/play\/?\?save=/, { timeout: 20000 });
  await page.getByRole('button', { name: '开始这一生' }).click();
  await waitForSegments(page, 1);
  const sidebar = await page.locator('aside').first().innerText();
  record('开放工坊：自定义世界可推进且显示对应属性', sidebar.includes('守书') && !sidebar.includes('阶位'));
  const saved = await page.evaluate(async () => {
    const request = indexedDB.open('newlife');
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const saves = await new Promise((resolve, reject) => { const query = db.transaction('saves', 'readonly').objectStore('saves').getAll(); query.onsuccess = () => resolve(query.result); query.onerror = () => reject(query.error); });
    db.close();
    return saves.find((save) => save.world.name === '荒原书屋');
  });
  record('开放工坊：存档使用新规则且不含旧阶位', saved?.world.ruleset?.kind === 'open_life' && saved?.rulesetVersion === 2 && saved?.character.attributes.stratum === undefined);
  record('开放工坊：无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
}

async function scenarioOpenWorlds(page, consoleErrors) {
  await configureModel(page);
  for (const spec of [
    { id: 'ashen-throne', name: '灰烬王座', visible: '公会评级', hidden: '寿元' },
    { id: 'star-ark', name: '星海孤舟', visible: '殖民地阶段', hidden: '寿元' },
  ]) {
    await page.goto(`${BASE_URL}/new`, { waitUntil: 'load' });
    await page.getByRole('button', { name: new RegExp(spec.name) }).first().click();
    await page.fill('#name', spec.id === 'star-ark' ? '林澈' : '阿灰');
    await page.getByRole('button', { name: '开始这一生' }).click();
    await page.waitForURL(/\/play\/?\?save=/, { timeout: 20000 });
    await page.getByRole('button', { name: '开始这一生' }).click();
    await waitForSegments(page, 1);
    const aside = await page.locator('aside').first().innerText();
    record(`${spec.name}：新局使用自己的状态分区`, aside.includes(spec.visible) && !aside.includes(spec.hidden), aside.replace(/\s+/g, ' ').slice(0, 95));
    const saved = await page.evaluate(async (worldId) => {
      const request = indexedDB.open('newlife');
      const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const saves = await new Promise((resolve, reject) => { const query = db.transaction('saves', 'readonly').objectStore('saves').getAll(); query.onsuccess = () => resolve(query.result); query.onerror = () => reject(query.error); });
      db.close();
      return saves.find((save) => save.world.id === worldId);
    }, spec.id);
    const consistent = spec.id === 'star-ark'
      ? saved?.worldAttributes?.progress > 0 && saved?.character.attributes.stage === undefined
      : saved?.character.attributes.rank === 1;
    record(`${spec.name}：结算结果写入正确对象`, Boolean(consistent), JSON.stringify({ world: saved?.worldAttributes, actorStage: saved?.character.attributes.stage, rank: saved?.character.attributes.rank }));
  }
  record('新增世界流程无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
}

// ────────────────────────────────────────────────────────────
// 场景五：响应被输出上限截断时的表现
// ────────────────────────────────────────────────────────────

async function scenarioTruncation(page, consoleErrors) {
  await configureModel(page);

  // 让模拟服务返回空内容 + finish_reason: length，复现真实的截断失败形态
  await setMockState({ emptyWithLength: true });

  // 连接自检只验证「连得上、鉴权通过、结构正确」，不该因为模型没来得及开口就报错。
  // 这里曾经用 max_tokens: 1 做自检，把一份完全正常的配置误判成「模型返回了空内容」。
  await page.goto(`${BASE_URL}/settings`, { waitUntil: 'load' });
  await page.getByRole('button', { name: '测试连接' }).click();
  await page.getByText(/连接正常/).waitFor({ timeout: 20000 });
  record('截断场景：连接自检不再误判，只验证链路', true);

  // 真正的段落生成应当给出可操作的提示，而不是笼统的「无法解析」
  await page.goto(`${BASE_URL}/new`, { waitUntil: 'load' });
  await page.getByRole('button', { name: /青冥仙途/ }).first().click();
  await page.locator('#name').waitFor({ state: 'visible' });
  await page.fill('#name', '截断测试');
  await page.getByRole('button', { name: '开始这一生' }).click();
  await page.waitForURL(/\/play\/?\?save=/, { timeout: 20000 });
  await page.getByRole('button', { name: '开始这一生' }).click();

  await page.getByText(/输出被长度上限截断/).waitFor({ timeout: 60000 });
  const actionable = await page.getByText(/单次输出上限/).count();
  record('截断场景：给出「调大输出上限」的可操作提示', actionable > 0);

  await page.screenshot({ path: path.join(SHOT_DIR, '11-truncated.png') });

  await setMockState({ emptyWithLength: false });
  record(
    '截断场景无控制台错误',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 2).join(' | '),
  );
}

// （场景六「AI 替我选 / 替我写」已随决策卡界面的简化移除——
//   卡片上的 AI 现在只有 Jev 的被动推演层，由 `jev` 场景覆盖。）

// ────────────────────────────────────────────────────────────
// 场景七：视图切换与推进控制
// ────────────────────────────────────────────────────────────

/**
 * 方案里的「两种视图切换」与「连续推进 / 暂停」是三个独立的界面承诺，
 * 但它们不改变任何数据，只看存档是验不出来的，必须真的点一遍。
 */
async function scenarioControls(page, consoleErrors) {
  await configureModel(page);
  await createCharacter(page, '控件者');

  await page.getByRole('button', { name: '开始这一生' }).click();
  await waitForSegments(page, 1);
  record('推进控制：第一段生成成功', true);

  // ── 年表 ↔ 事件流 ────────────────────────────────────────
  // 两个视图的差别只有一个：事件流不分年。
  const chronicleYears = await page.locator('[data-year-header]').count();
  record('视图切换：年表视图按年分组', chronicleYears >= 1, `${chronicleYears} 个年份分组`);

  await page.getByRole('button', { name: '事件流' }).click();
  await page.waitForTimeout(300);
  const streamYears = await page.locator('[data-year-header]').count();
  const streamSegments = await page.locator('[data-segment-id]').count();
  record(
    '视图切换：事件流视图不分年，条目仍在',
    streamYears === 0 && streamSegments >= 1,
    `年份分组 ${streamYears} 个、段落 ${streamSegments} 段`,
  );

  await page.getByRole('button', { name: '年表' }).click();
  await page.waitForTimeout(300);
  const backToChronicle = await page.locator('[data-year-header]').count();
  record('视图切换：切回年表后年份分组回来', backToChronicle >= 1);

  await page.screenshot({ path: path.join(SHOT_DIR, '14-views.png'), fullPage: true });

  // ── 连续推进可以中途暂停 ─────────────────────────────────
  // 把响应拖慢，好让「正在连续推进」这个状态有足够长的窗口可以打断
  await setMockState({ delayMs: 1200 });

  await waitForIdle(page);
  const before = await segmentCount(page);
  await page.getByRole('button', { name: '连续推进 ×5' }).click();

  // 先等这一批真的开始跑（段数涨了），再打断——否则可能在按钮出现前就点了
  await waitForSegments(page, before + 1, 60000);
  await page.getByRole('button', { name: '暂停' }).click();

  // 暂停后当前这一段仍会跑完，然后整批停下：暂停按钮消失
  await page.waitForFunction(
    () => ![...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === '暂停'),
    undefined,
    { timeout: 60000 },
  );

  const advanced = (await segmentCount(page)) - before;
  record(
    '推进控制：连续推进可以中途暂停',
    advanced < 5,
    `暂停前推进了 ${advanced} 段（一批是 5 段）`,
  );

  // 暂停之后还能继续单步推进——别把玩家卡在暂停状态里
  const beforeResume = await segmentCount(page);
  await setMockState({ delayMs: 350 });
  await advance(page);
  record('推进控制：暂停之后仍能继续推进', (await segmentCount(page)) > beforeResume);

  record(
    '推进控制流程无控制台错误',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 2).join(' | '),
  );
}

// ────────────────────────────────────────────────────────────
// 场景八：决策卡的 Jev 推演打分（正常路径 + 故障降级）
// ────────────────────────────────────────────────────────────

/**
 * 从 IndexedDB 里找出带推演分数的段记录。
 *
 * 分数是**事后补写**进段记录的，界面上看不出来有没有落库——
 * 只有直接读库才能确认「观测数据真的存下来了」。
 */
async function readScoredSegments(page) {
  return page.evaluate(async () => {
    const openRequest = indexedDB.open('newlife');
    const db = await new Promise((resolve, reject) => {
      openRequest.onsuccess = () => resolve(openRequest.result);
      openRequest.onerror = () => reject(openRequest.error);
    });
    const records = await new Promise((resolve, reject) => {
      const request = db.transaction('segments', 'readonly').objectStore('segments').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return records
      .filter((item) => item.segment?.decision !== undefined && item.jevScores !== undefined)
      .map((item) => ({
        topIndex: item.jevScores.topIndex,
        confidence: item.jevScores.confidence,
        optionCount: item.jevScores.probabilities.length,
      }));
  });
}

async function scenarioJev(page, consoleErrors) {
  await configureModel(page);
  await configureJev(page);

  // 大步推进 + 每段都提岔路：第一段就会停车，把决策卡送到玩家面前
  await setMockState({ advanceYears: 12, proposeDecision: true });
  await createCharacter(page, '推演者');

  await page.getByRole('button', { name: '开始这一生' }).click();
  await page.getByText('这是个岔路').waitFor({ timeout: 40000 });
  await waitForIdle(page);

  // ── 正常路径：推演层出现 ───────────────────────────────
  // 模拟服务的分布是确定的：序号 1 最高（50%），置信度固定 82%。
  await page.getByText('推演 · 这个角色会怎么走').waitFor({ timeout: 20000 });
  record('Jev 推演：决策卡出现推演层与置信度', (await page.getByText('置信 82%').count()) > 0);

  const scoredButtons = {
    top: await page.getByRole('button', { name: /婉拒 50%/ }).count(),
    others: await page.getByRole('button', { name: /跟他走 25%/ }).count(),
  };
  record(
    'Jev 推演：最高分选项与其余选项展示概率',
    scoredButtons.top > 0 && scoredButtons.others > 0,
    JSON.stringify(scoredButtons),
  );
  await page.screenshot({ path: path.join(SHOT_DIR, '15-jev-scores.png'), fullPage: true });

  const scored = await readScoredSegments(page);
  const scoreValid =
    scored.length > 0 &&
    scored.every((item) => item.topIndex === 1 && item.optionCount === 3 && item.confidence > 0);
  record(
    'Jev 推演：分数事后补写进段记录（IndexedDB）',
    scoreValid,
    JSON.stringify(scored),
  );

  // 按推演结果决策，流程照常
  await page.getByRole('button', { name: /婉拒 50%/ }).click();
  await waitForSegments(page, 2);
  const normalErrors = consoleErrors.filter((message) => !message.includes('systemone'));
  record('Jev 推演流程无控制台错误', normalErrors.length === 0, normalErrors.slice(0, 2).join(' | '));

  // ── 故障降级：打分 500，决策卡必须照常可用 ─────────────
  await setMockState({ jevFail: true });

  // 密度门槛「2 段之内最多 1 次决策」会拦住紧邻的岔路，循环推进直到下一张卡
  let reachedAgain = false;
  for (let guard = 0; guard < 10 && !reachedAgain; guard += 1) {
    const ended = await advance(page);
    if (ended) break;
    reachedAgain = (await page.getByText('这是个岔路').count()) > 0;
  }

  if (reachedAgain) {
    await waitForIdle(page);
    const cardShown = (await page.locator('[data-decision-option]').count()) > 0;
    const scoresHidden = (await page.getByText('推演 · 这个角色会怎么走').count()) === 0;
    record('Jev 故障注入：决策卡照常出现且没有推演层', cardShown && scoresHidden);

    await page.locator('[data-decision-option]').first().click();
    await page.waitForFunction(
      (target) =>
        document.querySelectorAll('[data-segment-id]').length >= target ||
        document.body.innerText.includes('此生终了') ||
        document.body.innerText.includes('故事收束'),
      (await segmentCount(page)) + 1,
      { timeout: 60000 },
    );
    record('Jev 故障注入：决策提交不受影响', true);
  } else {
    record('Jev 故障注入：决策卡照常出现且没有推演层', false, '10 次推进内没有再遇到岔路');
  }

  const unexpected = consoleErrors.filter(
    (message) => !message.includes('systemone') && !message.includes('推演失败'),
  );
  record(
    'Jev 故障注入：除预期的打分 500 外无控制台错误',
    unexpected.length === 0,
    unexpected.slice(0, 2).join(' | '),
  );

  await setMockState({ advanceYears: null, proposeDecision: false, jevFail: false });
}

// ────────────────────────────────────────────────────────────

async function main() {
  await mkdir(SHOT_DIR, { recursive: true });

  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  const consoleErrors = [];
  const recordConsoleError = (message) => consoleErrors.push(`${message} @ ${page.url()}`);
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // 资源加载失败的正文里不带 URL，只有 location 里有；不带上它，
    // 下游就无法区分「预期的打分端点 500」和真正的错误。
    const location = message.location()?.url ?? '';
    if (location.includes('/favicon.ico')) return; // 静态导出没有 favicon，纯环境噪声
    recordConsoleError(`${message.text()} [${location}]`);
  });
  page.on('pageerror', (error) => recordConsoleError(String(error)));

  try {
    if (ONLY === '' || ONLY === 'main') await scenarioMain(page, consoleErrors);
    if (ONLY === '' || ONLY === 'open-life') await scenarioOpenLife(page, consoleErrors);
    if (ONLY === '' || ONLY === 'worlds-open') await scenarioOpenWorlds(page, consoleErrors);
    if (ONLY === '' || ONLY === 'ending') await scenarioEnding(page, consoleErrors);
    if (ONLY === '' || ONLY === 'recovery') await scenarioRecovery(page, consoleErrors);
    if (ONLY === '' || ONLY === 'forge') await scenarioForge(page, consoleErrors);
    if (ONLY === '' || ONLY === 'forge-open') await scenarioOpenForge(page, consoleErrors);
    if (ONLY === '' || ONLY === 'truncation') await scenarioTruncation(page, consoleErrors);
    if (ONLY === '' || ONLY === 'controls') await scenarioControls(page, consoleErrors);
    if (ONLY === '' || ONLY === 'jev') await scenarioJev(page, consoleErrors);
  } finally {
    await browser.close();
  }

  const failed = steps.filter((step) => !step.ok);
  console.log(`\n共 ${steps.length} 项，失败 ${failed.length} 项。截图目录：${SHOT_DIR}`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
