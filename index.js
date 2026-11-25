/**
 * model-fetcher —— 在模型页每张 provider 卡片里，点一下拉它服务端的实时模型列表
 * ============================================================================
 * 背景：DSH 设置页的「获取可用模型 / 更新列表」对命中内置 catalog 的 provider 名
 * （例如 opencode-go）永远返回打包时的快照、根本不联网，所以新模型拉不到。
 * 原生 discovery 在 dsh-llm-pi-ai/src/discovery.ts:322-339 里做了短路：
 *
 *     if (request.provider !== undefined) {
 *       const installed = catalogModels(request.provider)   // 按名字查 pi-ai 内置目录
 *       if (installed.size > 0) return [...installed.values()]   // 命中就返回快照，不发请求
 *     }
 *
 * 所以这个名字下列出的模型永远停在打包那天。本插件直接打供应商的列表端点，
 * 拿到服务端真实列表，把「配置里还没有的」摆出来让人勾选，只把勾中的那几条
 * 并进该供应商的模型列表 —— 走官方 settings.mutate（SettingsForms 服务），由
 * ConfigEditor 原子写 + 失败回滚，不手改 YAML，也不整段覆盖（已有条目原样保留，
 * 含手写的 reasoningEfforts 等）。
 *
 * 为什么必须勾选：模型选择器会把 models 里的每一条都列出来，没有隐藏功能。
 * 全量写入 = 下拉框被撑满（实测 opencode-go 一次进来 34 条），所以写入以勾选为准。
 *
 * 协议（与 dsh-llm-pi-ai 的 discovery 对齐）：
 *   - openai-completions / openai-responses → GET {baseURL}/models           + authorization: Bearer
 *   - anthropic-messages                    → GET {root}/v1/models?limit=1000 + x-api-key + anthropic-version
 *   - google-generative-ai                  → GET {baseURL}/models?pageSize=1000 + x-goog-api-key
 *
 * 三样东西：
 *   1. 浏览器半边（client.js）：注册到官方座位 settings.models.provider-card，卡片内一行按钮；
 *   2. HTTP 接口 /api/model-fetcher/{fetch,apply}（只接受同源请求）；
 *   3. 工具 fetch_provider_models（对话里也能拉，只读）。
 */
import { defineTool } from './lib/toolkit.mjs'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-model-fetcher'
// 只声明真正必需的；webServer 在 apply 里用 ctx.inject 等它就绪（headless profile 没有它）
export const inject = ['tools']

const MAX_BYTES = 4 * 1024 * 1024
const TIMEOUT_MS = 30000
const MAX_MODELS = 500

// ── 拉列表 ─────────────────────────────────────────────────────────────────

function listingUrl(baseURL, api) {
  const root = String(baseURL || '').trim().replace(/\/+$/, '')
  if (!root) throw new Error('baseURL 不能为空')
  if (api === 'anthropic-messages') return root + '/v1/models?limit=1000'
  if (api === 'google-generative-ai') return root + '/models?pageSize=1000'
  return root + '/models'
}

function authHeaders(api, key) {
  if (!key) return {}
  if (api === 'anthropic-messages') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
  if (api === 'google-generative-ai') return { 'x-goog-api-key': key }
  return { authorization: 'Bearer ' + key }
}

function num(value) {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : undefined
}

function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

/**
 * 供应商常把 modalities 写成 mime 串（text / image/png / video/mp4 …），
 * 而 DSH 的 model.input 只认 text 与 image，其它一律丢弃 —— 写进配置的字段必须能过 schema。
 */
function modality(value) {
  const text = String(value || '').trim().toLowerCase()
  if (!text) return undefined
  if (text === 'text') return 'text'
  if (text.startsWith('image')) return 'image'
  return undefined
}

function modalities(entry) {
  const raw = pick(entry.input, entry.modalities?.input, entry.architecture?.input_modalities)
  const list = Array.isArray(raw) ? raw.map(modality).filter(Boolean) : []
  const unique = [...new Set(list)]
  if (unique.length > 0 && !unique.includes('text')) unique.unshift('text')
  return { input: unique.length > 0 ? unique : undefined }
}

function normalizeEntry(id, entry) {
  const source = entry && typeof entry === 'object' ? entry : {}
  return {
    id,
    name: String(pick(source.name, source.display_name, source.displayName) ?? id),
    contextWindow: num(pick(source.contextWindow, source.context_length, source.limit?.context, source.max_context_length)),
    maxTokens: num(pick(source.maxTokens, source.max_tokens, source.limit?.output, source.output_limit)),
    input: modalities(source).input,
  }
}

/** 写进配置时只留 DSH 认识的字段（多写的会被忽略，但保持干净） */
function writeEntry(model) {
  const out = { id: model.id }
  if (model.name && model.name !== model.id) out.name = model.name
  if (model.contextWindow) out.contextWindow = model.contextWindow
  if (model.maxTokens) out.maxTokens = model.maxTokens
  if (Array.isArray(model.input) && model.input.length > 0) out.input = [...model.input]
  return out
}

function parseModels(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('响应不是 JSON 对象')
  const out = []
  const push = (id, entry) => {
    if (typeof id === 'string' && id.trim()) out.push(normalizeEntry(id.trim(), entry))
  }
  if (Array.isArray(payload.data)) {
    for (const entry of payload.data) push(entry?.id, entry)
  } else if (payload.models && typeof payload.models === 'object' && !Array.isArray(payload.models)) {
    for (const [id, entry] of Object.entries(payload.models)) push(id, entry)
  } else if (Array.isArray(payload.models)) {
    for (const entry of payload.models) push(entry?.id ?? entry?.name, entry)
  }
  return out
}

async function fetchModels({ baseURL, api, apiKey }) {
  const url = listingUrl(baseURL, api)
  const res = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json', ...authHeaders(api, apiKey) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const body = await res.text()
  if (body.length > MAX_BYTES) throw new Error('响应超过 4MB 上限，已放弃解析')
  let payload
  try { payload = JSON.parse(body) } catch {
    throw new Error(`HTTP ${res.status} ${res.statusText}，响应不是 JSON：${body.slice(0, 200)}`)
  }
  if (!res.ok) {
    const detail = pick(payload.error?.message, payload.message, body.slice(0, 200))
    throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? '：' + String(detail).slice(0, 300) : ''}`)
  }
  return { url, payload }
}

function resolveKey(args) {
  const inline = String(args.apiKey || '').trim()
  if (inline.startsWith('$')) return process.env[inline.slice(1).trim()] || undefined
  if (inline) return inline
  const envName = String(args.apiKeyEnv || '').trim()
  return envName ? process.env[envName] || undefined : undefined
}

async function gather(args) {
  const api = args.api || 'openai-completions'
  const { url, payload } = await fetchModels({ baseURL: args.baseURL, api, apiKey: resolveKey(args) })
  const models = parseModels(payload)
  return { url, api, count: models.length, returned: Math.min(models.length, MAX_MODELS), models: models.slice(0, MAX_MODELS) }
}

// ── 从 DSH 配置里读出已配的供应商（给卡片按钮定位 baseURL / 算「新模型」）──────

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function indentOf(line) {
  return /^(\s*)/.exec(line)[1].length
}

function unquote(value) {
  const v = String(value || '').trim()
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) return v.slice(1, -1)
  return v
}

/**
 * 简易 YAML 扫描：只认 `providers:` 下的键。
 * 除了 provider 本身，还要把它的 models[].id 收进来 —— 卡片按钮靠它算「哪些是新模型」。
 * 宁可漏认也不错认：解析失败就返回空，按钮点了会提示「配置里没找到这个供应商」。
 */
function parseProviders(text) {
  const lines = String(text || '').split(/\r?\n/)
  const result = []
  for (let i = 0; i < lines.length; i++) {
    const header = /^(\s*)providers:\s*(?:#.*)?$/.exec(lines[i])
    if (!header) continue
    const base = header[1].length
    let providerIndent = -1
    let current = null
    let inModels = false
    let modelIndent = -1
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const ind = indentOf(line)
      if (ind <= base) break
      const kv = /^([A-Za-z0-9_.@/-]+):\s*(.*)$/.exec(trimmed)
      if (!kv) {
        // 列表项：`- id: xxx` 或 `- reasoningEffort: high`
        const item = /^-\s+([A-Za-z0-9_.@-]+):\s*(.*)$/.exec(trimmed)
        if (item && current && inModels && ind > modelIndent) {
          if (item[1] === 'id' && unquote(item[2])) current.modelIds.push(unquote(item[2]))
        }
        continue
      }
      if (providerIndent === -1) providerIndent = ind
      if (ind === providerIndent) {
        current = { name: kv[1], displayName: '', baseURL: '', api: '', apiKeyEnv: '', modelIds: [] }
        result.push(current)
        inModels = false
        continue
      }
      if (!current || ind <= providerIndent) continue
      const key = kv[1]
      const value = unquote(kv[2])
      // models 段：从 `models:` 起，缩进回落到 provider 直接子键时结束
      if (inModels && ind === modelIndent) inModels = false
      if (!inModels && key === 'models' && value === '') { inModels = true; modelIndent = ind; continue }
      if (inModels) continue
      if (key === 'baseURL') current.baseURL = value
      else if (key === 'api') current.api = value
      else if (key === 'apiKeyEnv') current.apiKeyEnv = value
      else if (key === 'displayName') current.displayName = value
    }
  }
  return result
}

function readProviders() {
  const home = dshHome()
  const files = [path.join(home, 'cordis.patch.yml')]
  try {
    for (const entry of fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true })) {
      if (entry.isDirectory()) files.push(path.join(home, 'profiles', entry.name, 'cordis.patch.yml'))
    }
  } catch { /* 没有 profiles 目录就只扫顶层 */ }
  const seen = new Set()
  const out = []
  for (const file of files) {
    let text = ''
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    for (const provider of parseProviders(text)) {
      const dedupe = provider.name + '|' + provider.baseURL
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      out.push({ ...provider, profile: path.basename(path.dirname(file)) })
    }
  }
  return out
}

/** 按 provider 名找到配置（优先 desktop profile）；找不到返回 undefined */
function resolveProvider(providerName) {
  const wanted = String(providerName || '').trim()
  if (!wanted) return undefined
  const all = readProviders()
  const own = all.filter((p) => p.name === wanted)
  if (own.length === 0) return undefined
  return own.find((p) => p.profile === 'desktop') || own[0]
}

// ── 读/写设置里的模型列表（走官方 settings 服务，不手改 YAML）─────────────────
//
// settings（SettingsForms 服务）暴露 describe / update / replace / mutate：
//   describe() → [{ ns, value, base, user, revision, … }]，value 是当前生效值
//   mutate(ns, [{op:'set'|'unset', path:string[], value?}], expectedRevision)
// 写入最终落到 profile 的 cordis.patch.yml，ConfigEditor 负责文件锁 + 原子写 + 失败回滚
// （dsh-config-editor/lib/index.js 的 edit()），写成功会触发 settings/document-updated，
// 模型页自己刷新。llm-pi-ai 的 Config 里 providers 整段标了 .volatile()，所以能热改。

let settingsService

function settingRows() {
  if (!settingsService || typeof settingsService.describe !== 'function') return []
  try {
    const rows = settingsService.describe()
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

/** 该 provider 当前生效的模型条目（保留配置里手写的字段，如 reasoningEfforts） */
function configuredModels(ns, providerName) {
  const rows = settingRows()
  const row = (ns && rows.find((item) => item.ns === ns))
    || rows.find((item) => item?.value?.providers?.[providerName])
  // user 层才是 patch 里真正写的那几条；生效值（value）可能把 schema 默认值补进来，
  // 回写时要优先照抄用户自己写的，避免把一整堆默认字段固化进配置。
  const candidates = [
    row?.user?.providers?.[providerName]?.models,
    row?.value?.providers?.[providerName]?.models,
  ]
  for (const list of candidates) {
    if (Array.isArray(list)) return list.filter((model) => model && typeof model.id === 'string')
  }
  // settings 服务还没起来时退回扫 patch（只有 id，没有容量字段）
  return (resolveProvider(providerName)?.modelIds || []).map((id) => ({ id }))
}

/** 写入目标 namespace：优先用客户端传来的（来自 adapter 的 settingsNs），否则从 describe 里找 */
function namespaceFor(ns, providerName) {
  if (ns) return ns
  const row = settingRows().find((item) => item?.value?.providers?.[providerName])
  if (!row) throw new Error('找不到该供应商所在的设置命名空间（settings 服务可能还没就绪）')
  return row.ns
}

/** 把实时列表里「配置里还没有」的模型并进去，已有的条目原样保留 */
function mergeModels(existing, live) {
  const known = new Set(existing.map((model) => model.id))
  const fresh = live.filter((model) => !known.has(model.id)).map(writeEntry)
  return { value: [...existing, ...fresh], added: fresh.map((model) => model.id) }
}

// ── HTTP（设置页用）────────────────────────────────────────────────────────

function sendJson(res, code, obj) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1e6) { req.destroy(); reject(new Error('请求体过大')) }
    })
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}) } catch { reject(new Error('请求体不是 JSON')) }
    })
    req.on('error', reject)
  })
}

/** 只放行同源请求；curl / 同源 fetch 没有 Origin 头也放行 */
function sameOrigin(req) {
  const origin = req.headers?.origin
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    return parsed.host === (req.headers.host || '')
  } catch { return false }
}

async function handle(webServer, req, res) {
  if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: '跨站请求被拒（只接受同源）' })
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname
  const sub = pathname.replace('/api/model-fetcher', '') || '/'
  try {
    // 拉：给 provider 名（Host 自己去配置里查 baseURL / api / apiKeyEnv），返回实时列表 + 差集
    if (sub === '/fetch' && req.method === 'POST') {
      const body = await readBody(req)
      const providerName = String(body.provider || '').trim()
      if (!body.baseURL && providerName) {
        const found = resolveProvider(providerName)
        if (!found) throw new Error('DSH 配置里没找到供应商：' + providerName)
        body.baseURL = found.baseURL
        body.api = body.api || found.api
        body.apiKeyEnv = body.apiKeyEnv || found.apiKeyEnv
      }
      const result = await gather(body)
      const existing = configuredModels(body.ns, providerName)
      const known = new Set(existing.map((model) => model.id))
      const added = result.models.filter((model) => !known.has(model.id)).map((model) => model.id)
      return sendJson(res, 200, { ok: true, ...result, configured: existing.length, added })
    }
    // 写：只把用户勾中的那几条并进该供应商的模型列表（走官方 settings.mutate）
    if (sub === '/apply' && req.method === 'POST') {
      const body = await readBody(req)
      const providerName = String(body.provider || '').trim()
      if (!providerName) throw new Error('缺少 provider')
      if (!settingsService) throw new Error('settings 服务还没就绪，稍后再试')
      const ids = Array.isArray(body.ids) ? body.ids.map((id) => String(id).trim()).filter(Boolean) : []
      if (ids.length === 0) throw new Error('没有勾选任何模型')
      const found = resolveProvider(providerName)
      if (!found) throw new Error('DSH 配置里没找到供应商：' + providerName)
      const ns = namespaceFor(String(body.ns || '').trim(), providerName)
      const settingsPath = Array.isArray(body.settingsPath) && body.settingsPath.length > 0
        ? body.settingsPath.map(String)
        : ['providers', providerName]
      const live = await gather({ baseURL: found.baseURL, api: found.api, apiKeyEnv: found.apiKeyEnv })
      const wanted = new Set(ids)
      const selected = live.models.filter((model) => wanted.has(model.id))
      if (selected.length === 0) {
        throw new Error('勾选的模型在服务端列表里已经不存在了，重新拉一次')
      }
      const { value, added } = mergeModels(configuredModels(ns, providerName), selected)
      if (added.length === 0) {
        return sendJson(res, 200, { ok: true, changed: false, added, total: value.length })
      }
      await settingsService.mutate(ns, [{ op: 'set', path: [...settingsPath, 'models'], value }], undefined)
      return sendJson(res, 200, { ok: true, changed: true, added, total: value.length })
    }
    return sendJson(res, 404, { ok: false, error: 'not found: ' + sub })
  } catch (error) {
    return sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

// ── 插件 ───────────────────────────────────────────────────────────────────

export function apply(ctx) {
  const log = (...args) => {
    try { ctx.logger.info('[model-fetcher]', ...args) } catch { /* 没有 logger 也不影响功能 */ }
  }

  // 工具：对话里也能拉（Host HTTP 之外的第二入口）
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'fetch_provider_models',
    description: 'Fetch the live model list of a provider by calling its listing endpoint (GET {baseURL}/models). Use when a provider\'s own model list looks stale, or when DSH discovery returns a bundled snapshot. Read-only: ids, display names, context/max-token limits.',
    parameters: {
      provider: { type: 'string' },
      baseURL: { type: 'string', required: true },
      api: { type: 'string', enum: ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'] },
      apiKey: { type: 'string' },
      apiKeyEnv: { type: 'string' },
    },
    async execute(args) {
      try {
        const result = await gather(args)
        return { ok: true, provider: args.provider, ...result }
      } catch (error) {
        return { ok: false, provider: args.provider, baseURL: args.baseURL, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })), 'model-fetcher: fetch tool')

  // 设置页接口：等 webServer 就绪再挂（不能写进静态 inject：headless profile 没有它）。
  // 只挂一次：webserver 对重复 prefix 路由直接抛错，而且 effect 在定时器里调用是非法的，
  // 任何一次未捕获异常都会把 host 进程带崩 —— 所以这里必须 mounted + try/catch 双保险。
  let mounted = false
  const mountRoutes = (webServer) => {
    if (mounted) return
    try {
      ctx.effect(() => webServer.register({
        kind: 'prefix',
        path: '/api/model-fetcher',
        handler: (req, res) => handle(webServer, req, res),
      }), 'model-fetcher: http routes')
      mounted = true
      log('http mounted at /api/model-fetcher')
    } catch (error) {
      try { ctx.logger.warn('[model-fetcher] http 挂载失败：', error) } catch { /* 不抛 */ }
    }
  }

  // settings：官方设置服务，用来把模型列表写回去（不手改 YAML）。
  // 它比 webServer 早，但同样只在就绪时注入；没有它时工具与只读接口照常工作。
  try {
    ctx.inject(['settings'], (c) => { settingsService = c.settings })
  } catch { /* 没有 settings 就只剩「拉取」能力 */ }

  try {
    ctx.inject(['webServer'], (c) => mountRoutes(c.webServer))
  } catch { /* 没有 ctx.inject 就只提供工具，不动 webServer */ }
}
