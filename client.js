/**
 * model-fetcher · 浏览器半边
 * ============================================================================
 * 注册到官方座位 settings.models.provider-card（keyed，key = 该 provider 家族的
 * settingsNs，pi-ai 家族固定是 'llm-pi-ai'）：每张供应商卡片里多一行。
 *
 *   点「拉取实时模型」→ Host 读配置拿 baseURL → 打供应商的列表端点
 *                    → 和当前生效的模型列表求差，列出「配置里还没有的」
 *   勾选其中几个（默认一条不勾）→ 点「写入选中」
 *                    → Host 调官方 settings.mutate，只把勾中的并进该供应商的
 *                      模型列表（已有条目原样保留），模型页随后自己刷新
 *
 * 为什么默认不勾：DSH 的模型选择器会把 models 里的每一条都列出来，没有隐藏功能，
 * 一次写进全部就会把下拉框撑满 37 行。所以「写什么」必须由人点。
 *
 * 约束（dsh-doc references/practices.md）：
 *   - 只 require('react')，不 require 任何 Harness Client 包（版本会变，崩了整个 slot）；
 *   - 挂在官方座位里，不往 document.body 追加节点；
 *   - 样式用 style 标签 + ctx.effect 清理，类名统一 mf- 前缀。
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-fetcher',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/api/model-fetcher'

    async function jsonFetch(path, init) {
      const response = await fetch(API + path, { credentials: 'same-origin', ...init })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error('服务端返回的不是 JSON（HTTP ' + response.status + '）')
      }
      if (!payload || payload.ok !== true) {
        throw new Error((payload && payload.error) || '请求失败（HTTP ' + response.status + '）')
      }
      return payload
    }

    const post = (path, body) =>
      jsonFetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

    /** 1000000 → 1M，65536 → 64K */
    function formatLimit(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return ''
      if (value >= 1000000) {
        const millions = value / 1000000
        return (Number.isInteger(millions) ? millions : millions.toFixed(1)) + 'M'
      }
      if (value >= 1000) return Math.round(value / 1000) + 'K'
      return String(value)
    }

    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }
      static getDerivedStateFromError() {
        return { failed: true }
      }
      render() {
        if (this.state.failed) {
          return h('div', { className: 'mf-line mf-warn' }, '模型拉取插件出错，已隐藏（不影响其他设置）')
        }
        return this.props.children
      }
    }

    /**
     * 卡片里的一行。props 来自官方 provider-card 座位：
     *   provider      = row.entry，含 provider（key）/ displayName / settingsNs / settingsPath …
     *   configured    = 这一行是否已保存
     *   keyConfigured = 密钥是否已配
     */
    function CardRow(props) {
      const entry = (props && props.provider) || {}
      const name = entry.provider || ''
      const ns = entry.settingsNs || ''
      const settingsPath = Array.isArray(entry.settingsPath) ? entry.settingsPath : []

      const [state, setState] = React.useState('idle') // idle | pulling | ready | writing | done | error
      const [error, setError] = React.useState('')
      const [live, setLive] = React.useState(null)
      const [written, setWritten] = React.useState(null)
      const [picked, setPicked] = React.useState({}) // id -> true

      if (!name) return null

      const pull = async () => {
        setState('pulling')
        setError('')
        setWritten(null)
        setPicked({})
        try {
          const data = await post('/fetch', { provider: name, ns })
          setLive(data)
          setState('ready')
        } catch (err) {
          setError(String((err && err.message) || err))
          setState('error')
        }
      }

      const added = (live && Array.isArray(live.added)) ? live.added : []
      const fresh = (live && Array.isArray(live.models)) ? live.models.filter((model) => added.includes(model.id)) : []
      const chosen = added.filter((id) => picked[id] === true)

      const toggle = (id) => {
        setPicked((previous) => {
          const next = { ...previous }
          if (next[id]) delete next[id]
          else next[id] = true
          return next
        })
      }

      const pickAll = (on) => {
        if (!on) {
          setPicked({})
          return
        }
        const next = {}
        for (const id of added) next[id] = true
        setPicked(next)
      }

      const write = async () => {
        if (chosen.length === 0) return
        setState('writing')
        setError('')
        try {
          const data = await post('/apply', { provider: name, ns, settingsPath, ids: chosen })
          setWritten(data)
          setLive(null)
          setPicked({})
          setState('done')
        } catch (err) {
          setError(String((err && err.message) || err))
          setState('error')
        }
      }

      const reset = () => {
        setLive(null)
        setWritten(null)
        setError('')
        setPicked({})
        setState('idle')
      }

      return h(Boundary, null,
        h('div', { className: 'mf-line' },
          h('button', {
            type: 'button',
            className: 'mf-btn' + (state === 'ready' && chosen.length > 0 ? ' mf-btn-primary' : ''),
            disabled: state === 'pulling' || state === 'writing' || (state === 'ready' && chosen.length === 0),
            title: '直接请求这个供应商的模型列表端点，不走 DSH 内置目录',
            onClick: state === 'ready' ? write : pull,
          },
            state === 'pulling' ? '拉取中…'
              : state === 'writing' ? '写入中…'
                : state === 'ready' ? (chosen.length > 0 ? '写入选中（' + chosen.length + '）' : '先勾选要加的模型')
                  : state === 'done' ? '再拉一次'
                    : '拉取实时模型'),
          state === 'ready'
            ? h('button', { type: 'button', className: 'mf-btn', onClick: reset }, '取消')
            : null,
          state === 'ready'
            ? h('span', { className: 'mf-hint' },
                '接口 ' + live.count + ' 个 · 配置 ' + live.configured + ' 个 · ',
                added.length > 0
                  ? h('span', { className: 'mf-new' }, '新增 ' + added.length + ' 个')
                  : h('span', null, '已是最新'),
              )
            : null,
          state === 'done'
            ? h('span', { className: 'mf-ok' },
                written && written.changed
                  ? '已写入 ' + written.added.length + ' 个新模型，现在共 ' + written.total + ' 个'
                  : '没有可写入的模型',
              )
            : null,
          state === 'error' ? h('span', { className: 'mf-warn' }, error) : null,
        ),
        state === 'ready' && added.length > 0
          ? h('div', { className: 'mf-box' },
              h('div', { className: 'mf-box-head' },
                h('span', { className: 'mf-box-title' }, '新增 ' + added.length + ' 个，勾选要写进模型列表的'),
                h('span', { className: 'mf-box-url' }, live.url),
              ),
              h('div', { className: 'mf-toolbar' },
                h('button', { type: 'button', className: 'mf-mini', onClick: () => pickAll(true) }, '全选'),
                h('button', { type: 'button', className: 'mf-mini', onClick: () => pickAll(false) }, '全不选'),
                h('span', { className: 'mf-count' }, '已选 ' + chosen.length + ' / ' + added.length),
              ),
              h('div', { className: 'mf-list' },
                fresh.map((model) => {
                  const id = model.id
                  const meta = [
                    formatLimit(model.contextWindow) ? '上下文 ' + formatLimit(model.contextWindow) : '',
                    formatLimit(model.maxTokens) ? '输出 ' + formatLimit(model.maxTokens) : '',
                  ].filter(Boolean).join(' · ')
                  return h('label', { key: id, className: 'mf-item' },
                    h('input', {
                      type: 'checkbox',
                      className: 'mf-check',
                      checked: picked[id] === true,
                      onChange: () => toggle(id),
                    }),
                    h('span', { className: 'mf-id' }, id),
                    model.name && model.name !== id ? h('span', { className: 'mf-name' }, model.name) : null,
                    meta ? h('span', { className: 'mf-meta' }, meta) : null,
                  )
                }),
              ),
              h('div', { className: 'mf-tip' }, '已有的模型保持原样；只追加勾中的这几条，没勾的不会进配置。'),
            )
          : null,
      )
    }

    const CSS = `
.mf-line { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 8px; font-size: 12px; }
.mf-btn { height: 26px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-subtle, #d0d5dd); border-radius: 6px; background: var(--dsw-alias-bg-surface, #fff); color: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
.mf-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-hover, #f2f4f7); }
.mf-btn:disabled { opacity: .55; cursor: default; }
.mf-btn-primary { background: var(--dsw-alias-bg-brand, #1570ef); border-color: var(--dsw-alias-bg-brand, #1570ef); color: #fff; }
.mf-hint { color: var(--dsw-alias-text-secondary, #667085); }
.mf-warn { color: var(--dsw-alias-text-danger, #b42318); }
.mf-ok { color: var(--dsw-alias-text-success, #067647); }
.mf-new { color: var(--dsw-alias-text-success, #067647); font-weight: 600; }
.mf-box { margin-top: 8px; border: 1px solid var(--dsw-alias-border-subtle, #d0d5dd); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; background: var(--dsw-alias-bg-surface, #fff); }
.mf-box-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.mf-box-title { font-weight: 600; font-size: 12px; }
.mf-box-url { color: var(--dsw-alias-text-secondary, #667085); font-size: 11px; word-break: break-all; }
.mf-toolbar { display: flex; align-items: center; gap: 8px; }
.mf-mini { height: 22px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-subtle, #d0d5dd); border-radius: 5px; background: transparent; color: inherit; font-size: 11px; cursor: pointer; }
.mf-mini:hover { background: var(--dsw-alias-bg-hover, #f2f4f7); }
.mf-count { color: var(--dsw-alias-text-secondary, #667085); font-size: 11px; }
.mf-list { max-height: 220px; overflow: auto; border: 1px solid var(--dsw-alias-border-subtle, #eaecf0); border-radius: 6px; }
.mf-item { display: flex; align-items: center; gap: 8px; padding: 4px 8px; font-size: 12px; border-top: 1px solid var(--dsw-alias-border-subtle, #f2f4f7); cursor: pointer; }
.mf-item:first-child { border-top: none; }
.mf-item:hover { background: var(--dsw-alias-bg-hover, #f9fafb); }
.mf-check { margin: 0; cursor: pointer; }
.mf-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.mf-name { color: var(--dsw-alias-text-secondary, #667085); }
.mf-meta { margin-left: auto; color: var(--dsw-alias-text-secondary, #667085); font-size: 11px; white-space: nowrap; }
.mf-tip { color: var(--dsw-alias-text-secondary, #667085); font-size: 11px; }
`

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'model-fetcher')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'model-fetcher: card styles')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        try {
          // keyed 座位只认 key（不认 id），owner 派发的 entryKey = row.entry.settingsNs；
          // pi-ai 家族的 namespace 固定是 'llm-pi-ai'（cordis.patch.yml 里那条的 id），
          // 注册这一次就收到该家族的全部供应商卡片。
          slots.inject('settings.models.provider-card', () =>
            slots.register(
              { name: 'settings.models.provider-card', key: 'llm-pi-ai' },
              CardRow,
            ),
          )
        } catch (error) {
          console.warn('[model-fetcher] provider-card 座位注册失败', error)
        }
      },
    }
  },
})
