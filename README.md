# AI 人生引擎

由大语言模型驱动的文字人生模拟器。世界按自己的时间前进，你在真正影响命运的岔路口做选择。

> **发布状态：尚无正式版本。** 仓库中的 `package.json` 版本字段为 `0.1.0`，目前还没有 GitHub Release。

## 功能

- 在青冥仙途、浮生记、灰烬王座、星海孤舟四种世界中开启人生，也可以生成自定义世界。
- 以年表或事件流阅读人生；模型提出剧情，程序按所选世界的规则校验并结算状态与结局。点击「继续」时条目逐条呈现。
- 新开的《浮生记》按事业、健康与经历推进；《灰烬王座》的公会评级依据委托或评定事件变化；《星海孤舟》的殖民地进展与人物健康分别保存。它们都没有自动晋阶续命。《青冥仙途》保留阶位寿元规则，旧存档按创建时的规则继续游玩。
- 在关键节点选择行动，并可选用 Jev 推演辅助比较选项。
- 将存档保存在本机浏览器，支持导入和导出备份。

世界工坊可先选择「开放人生」或「阶位成长」模板。开放人生模板目前适合会自然衰老的人类角色，程序会检查规则能否自然收束；这项检查不预测模型生成剧情的实际分布。结构化人生目标和跨代接班尚未提供。改造记录见[产品结构与规则重组方案](docs/产品结构与规则重组方案.md)。

## 环境要求

- Node.js 20.9 或更高版本
- npm
- 支持 IndexedDB、localStorage 和 Fetch API 的现代浏览器

## 安装与运行

```bash
git clone https://github.com/Anchor-anke/NewLife.git
cd NewLife
npm ci
npm run dev
```

打开终端显示的本地地址（默认 `http://localhost:3000`）。首次使用时进入“设置”，填写 OpenAI 兼容服务的接口地址、模型名称和 API Key，测试连接并保存，然后创建角色开始游玩。

模型请求由浏览器直接发送到你配置的服务地址。服务商需要允许浏览器跨域访问（CORS）；如果连接测试因跨域策略失败，请使用允许浏览器访问的兼容网关或自建代理。

### 不使用真实模型试用

项目带有本地模拟模型服务，可以不填真实 API Key，也不消耗模型额度。分别在两个终端运行：

```bash
# 终端一：启动模拟模型
npm run mock:model
```

```bash
# 终端二：启动应用
npm run dev
```

在应用的“设置”中填写以下测试配置，测试连接并保存：

- 接口地址：`http://127.0.0.1:8787/v1`
- 模型名称：`mock`
- API Key：任意非空文本，例如 `mock-key`

### 静态部署

项目使用 Next.js 静态导出。运行构建后，将 `out/` 目录部署到支持静态文件的托管服务：

```bash
npm run build
```

如需在本机预览导出结果，可运行 `npm run serve:static`，然后打开 `http://127.0.0.1:3000`。该预览命令需要安装 Python 3。

## 数据与 API Key

- 存档和自定义世界保存在当前浏览器的 IndexedDB 中，不会自动同步到其他设备。建议定期从存档页导出备份。
- API Key 默认只保存在当前标签页的会话存储中，关闭标签页后失效；勾选“记住到本机”后会保存到浏览器的 localStorage。
- 浏览器存储不是安全的密钥仓库，应用不会对 API Key 做加密。模型请求直接发送到你填写的服务地址。

## 开发命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动本地开发服务器 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | 运行 Vitest 单元测试 |
| `npm run build` | 构建并导出静态站点到 `out/` |
| `npm run mock:model` | 启动本地模拟模型服务 |

## 项目结构

```text
src/app/          页面与应用布局
src/components/   界面组件
src/lib/engine/   世界规则、叙事段落、决策与结算
src/lib/model/    OpenAI 兼容模型适配
src/lib/storage/  IndexedDB 存档与迁移
src/lib/worlds/   内置世界与自定义世界生成
scripts/          本地模拟服务及开发辅助脚本
docs/             设计方案与实施记录
```

## 更新日志与反馈

- [更新日志](CHANGELOG.md)
- [GitHub Releases](https://github.com/Anchor-anke/NewLife/releases)
- [提交问题或建议](https://github.com/Anchor-anke/NewLife/issues)

## 许可证

仓库目前没有附带许可证文件；如需使用、修改或再分发，请先联系作者取得许可。
