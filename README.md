# dsh-model-fetcher

在模型设置页的**每张供应商卡片里**加一个按钮：点一下拉取该供应商的**实时**模型列表，
勾选要用的几条，一键写进模型列表——新模型立刻出现在模型选择器里。

- **拉**：直接 `GET` 供应商的列表端点，不走 DSH 内置的 catalog 快照。
- **勾**：列出「配置里还没有的」模型，**默认一条不勾**，勾谁写谁。
- **写**：走官方 `settings.mutate`（ConfigEditor 原子写 + 失败回滚），只追加勾中的、
  已有条目原样保留（手写的 `reasoningEfforts` 等不会被抹掉）。

## 为什么必须勾选

模型选择器会把 `models` 里的**每一条**都列出来，没有隐藏功能。所以「拉全量」= 下拉框
被撑满：opencode-go 实测一次会进来 34 条，模型栏直接爆掉。写入必须以人工勾选为准，
默认全不勾，勾中的才进配置。

## 为什么需要它

DSH 的「获取可用模型 / 更新列表」在遇到**内置 catalog 里已有**的 provider 名时，
会直接从打包目录返回快照、**完全不发网络请求**（`dsh-llm-pi-ai` 的 `discovery.ts:322-339`）：

```ts
if (request.provider !== undefined) {
  const installed = catalogModels(request.provider)   // 按名字查 pi-ai 内置目录
  if (installed.size > 0) return [...installed.values()]  // 命中就返回快照，不发请求
}
```

于是新上线的模型永远不出现——例如 opencode-go 的 `hungerg-free`：服务端早就有
（37 个模型），快照里只有 29 个，搜 `hu` 一无所获。这个插件绕开那条路径，自己问服务端，
再把结果并进配置。

## 安装

```bash
dsh plugin add dsh-model-fetcher
```

或从本地目录安装：`dsh plugin add /path/to/model-fetcher`。装完重启 DSH 桌面端。

## 用法

打开 **设置 → 模型**，找到要更新的供应商卡片（如 OpenCode Go），卡底多出一行：

1. 点 **拉取实时模型** → 显示「接口 37 个 · 配置 3 个 · **新增 34 个**」并列出新模型；
2. 在清单里勾选要加的（可用「全选 / 全不选」）→ 按钮变成 **写入选中（N）**；
3. 点它 → 提示「已写入 N 个新模型，现在共 M 个」，模型选择器随即刷新。

没有新增时显示「已是最新」，按钮不可点。写入后想撤销：在模型目录里点该条目的垃圾桶，
或从备份恢复 `~/.dsh/profiles/<profile>/cordis.patch.yml`。

## 支持的协议

列表端点按 adapter 协议选择，与官方 discovery 一致：

| 协议 | 请求 |
| --- | --- |
| `openai-completions` / `openai-responses` | `GET {baseURL}/models` + `Authorization: Bearer` |
| `anthropic-messages` | `GET {baseURL}/v1/models?limit=1000` + `x-api-key` |
| `google-generative-ai` | `GET {baseURL}/models?pageSize=1000` + `x-goog-api-key` |

响应兼容 `data` 数组、`models` 数组、`models` 映射三种形状；读 `id` / `name` /
`contextWindow`（或 `context_length` / `limit.context`）/ `maxTokens`（或 `limit.output`），
`input` 里的 mime 串（`image/png` 等）归一成 `text` / `image`——配置 schema 只认这两个。

## 写入的字段

只写 DSH 认识的五个字段，避免往配置里塞噪音：

```yaml
- id: hungerg-free
  name: HungerG Free
  contextWindow: 1000000
  maxTokens: 65536
  input: [text, image]
```

不带容量字段会落到 provider 的 `defaultContextWindow` / `defaultMaxTokens`（通常偏小），
所以拉到的 `limit` 一定要带上。

## 对话里也能用

插件同时注册了工具 `fetch_provider_models`（只读）：

```json
{ "baseURL": "https://opencode.ai/zen/go/v1", "apiKeyEnv": "OPENCODE_GO_API_KEY" }
```

返回 `{ ok, count, models: [{ id, name, contextWindow, maxTokens }] }`。

## 安全边界

- 面板接口只接受**同源**请求（`/api/model-fetcher/{fetch,apply}`）。
- **写**这一侧只动 `providers.<该供应商>.models` 这一个路径，且只做追加；
  不碰 `baseURL` / `api` / `apiKeyEnv` / 其它供应商。
- 密钥不落盘：卡片按钮用的是配置里已有的 `apiKeyEnv`，由 Host 从进程环境变量读；
  页面不接触密钥。
- 响应体上限 4 MB、超时 30 秒。
- 没有 `webServer`（headless profile）时只注册工具，不挂 HTTP 路由；
  没有 `settings` 服务时只提供拉取，不提供写入。

## 局限

- 供应商定位靠简易 YAML 扫描（只认 `providers:` 段下的 `name/baseURL/api/apiKeyEnv/displayName/models[].id`），
  非标准写法可能扫不到——这时会提示「配置里没找到供应商」。
- 只列模型，不判断哪些真能调通（`reasoningEfforts` 等能力字段来自内置 catalog，
  新模型可以按需手补）。
- 写入是「追加」语义：服务端下线了某个模型，不会自动从配置里移除。
