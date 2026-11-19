/**
 * live-delivery 的 Client 半：输入框下方一条状态药丸，点开是挂在 body 上的浮层。
 * 药丸与浮层直接沿用内置统计药丸（StatsPills / stat-dialog）的 token、尺寸与交互：
 * 静止 tertiary、悬停/展开 interactive-bg-hover + secondary，浮层用 specific-menu 表面与 elevation-prominent。
 */

window.__ModuleLoader__.load({
  id: '@0rch1d/dsh-live-delivery',

  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    const ROUTE = '/api/live-delivery/query'
    const SLOT = 'conversation.composer.dock'

    const STRINGS = {
      en: {
        open: 'Live delivery',
        active: 'delivering',
        complete: 'complete',
        stopped: 'stopped',
        empty: 'No version yet',
        idle: 'not started',
        files: 'files',
        justNow: 'just now',
        minutes: 'min ago',
        hours: 'h ago',
      },
      zh: {
        open: '渐进交付',
        active: '交付中',
        complete: '已完成',
        stopped: '已停止',
        empty: '还没有交付版本',
        idle: '未开始',
        files: '个文件',
        justNow: '刚刚',
        minutes: '分钟前',
        hours: '小时前',
      },
    }

    const CSS = `
.ldv-anchor {
  display: inline-flex; min-width: 0;
  font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
}
.ldv-pill {
  display: inline-flex; align-items: center; gap: 6px;
  box-sizing: border-box; max-width: 100%;
  padding: 1px 8px; border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit; font-variant-numeric: tabular-nums; line-height: inherit; white-space: nowrap;
  cursor: pointer;
}
.ldv-pill svg { width: 14px; height: 14px; flex: none; }
.ldv-pill[aria-expanded='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
@media (hover: hover) {
  .ldv-pill:hover {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-secondary);
  }
}
.ldv-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ldv-pop {
  position: fixed; z-index: 1100; box-sizing: border-box;
  width: min(400px, calc(100vw - 24px));
  padding: 16px;
  border: 0; border-radius: var(--dsw-radius-lg);
  background: var(--dsw-specific-menu);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  cursor: default;
  max-height: min(420px, calc(100dvh - 24px));
  overflow: hidden;
  animation: ldv-in .14s ease-out;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
@keyframes ldv-in {
  from { opacity: 0; transform: translateY(4px) scale(.99); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .ldv-pop { animation: none; }
}
.ldv-title {
  display: flex; justify-content: space-between; gap: 16px;
  margin-bottom: 8px;
  color: var(--dsw-alias-label-primary); font-weight: 500;
}
.ldv-title-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ldv-title-value { flex: none; font-variant-numeric: tabular-nums; }
.ldv-bar { height: 2px; margin: 2px 0 10px; border-radius: 1px; background: var(--dsw-alias-border-l1); overflow: hidden; flex: none; }
.ldv-bar-fill { height: 100%; background: var(--dsw-alias-brand-primary); transition: width .3s ease; }
.ldv-rows {
  display: flex; flex-direction: column;
  max-height: 220px; overflow-y: auto; overscroll-behavior: contain;
  scrollbar-width: thin;
}
.ldv-rows.is-fade {
  mask-image: linear-gradient(to bottom, #000 calc(100% - 12px), transparent);
}
.ldv-row {
  display: grid; grid-template-columns: 10px 22px minmax(0, 1fr) auto;
  align-items: baseline; column-gap: 8px;
  padding: 6px 8px; border-radius: 8px;
}
@media (hover: hover) {
  .ldv-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
}
.ldv-node { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-border-l2); align-self: center; flex: none; }
.ldv-row:first-child .ldv-node { background: var(--dsw-alias-brand-primary); }
.ldv-vn { color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.ldv-name { color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ldv-time { color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.ldv-note { color: var(--dsw-alias-label-tertiary); }
`

    // 样式在 apply() 里随插件 fiber 注册：模块物化（factory）不产生副作用，
    // 插件卸载或 HMR 重载时由 effect 清理，不会重复积累 <style> 元素。
    const STYLE_ID = 'live-delivery'

    const formatDuration = (ms) => {
      if (ms === null || ms === undefined || !Number.isFinite(ms)) return ''
      const total = Math.max(0, Math.round(ms / 1000))
      if (total < 60) return `${total}s`
      const minutes = Math.floor(total / 60)
      if (minutes < 60) return `${minutes}m`
      const hours = Math.floor(minutes / 60)
      const rest = minutes % 60
      return rest === 0 ? `${hours}h` : `${hours}h${rest}m`
    }

    const formatBytes = (bytes) => {
      const value = Number(bytes) || 0
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
      return `${(value / (1024 * 1024)).toFixed(1)} MB`
    }

    async function request(sessionId, payload = { method: 'state' }, signal) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, ...payload }),
        signal,
      })
      let data
      try {
        data = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (data === null || typeof data !== 'object' || data.ok !== true) {
        throw new Error(data?.error?.message ?? `HTTP ${response.status}`)
      }
      return data.value
    }

    /** 药丸图标：14px，与内置药丸的 svg 尺寸一致。 */
    const glyph = () => h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' },
      h('rect', { x: 2, y: 10, width: 3.4, height: 4, rx: 1, fill: 'currentColor', opacity: 0.45 }),
      h('rect', { x: 6.3, y: 7, width: 3.4, height: 7, rx: 1, fill: 'currentColor', opacity: 0.7 }),
      h('rect', { x: 10.6, y: 2, width: 3.4, height: 12, rx: 1, fill: 'currentColor' }))

    return {
      inject: ['slots'],

      apply(ctx) {
        const locale = ctx.get('locale')

        // 与内置插件的做法一致：样式随插件 fiber 注册，卸载时移除。
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = '@0rch1d/dsh-live-delivery'
          style.dataset.pluginCss = STYLE_ID
          style.textContent = CSS
          document.head.append(style)
          return () => style.remove()
        })

        const translate = (key) => {
          let active = 'en'
          try {
            active = locale?.getSnapshot?.()?.active ?? 'en'
          } catch {
            active = 'en'
          }
          const dict = String(active).toLowerCase().startsWith('zh') ? STRINGS.zh : STRINGS.en
          return dict[key] ?? STRINGS.en[key] ?? key
        }

        // 语言切换后重渲染药丸：订阅 locale 服务的 revision（与内置药丸一致）。
        const localeSubCache = new WeakMap()
        const noopSubscribe = () => () => {}
        const localeSubscriptionOf = (face) => {
          if (face === null || face === undefined || typeof face.subscribe !== 'function') return null
          let sub = localeSubCache.get(face)
          if (sub === undefined) {
            sub = {
              subscribe: (listener) => face.subscribe(listener),
              getRevision: () => face.getSnapshot().revision,
            }
            localeSubCache.set(face, sub)
          }
          return sub
        }
        function useLocaleRevision() {
          const sub = localeSubscriptionOf(locale)
          return React.useSyncExternalStore(
            sub === null ? noopSubscribe : sub.subscribe,
            sub === null ? () => 0 : sub.getRevision,
            () => 0,
          )
        }

        function Panel(props) {
          useLocaleRevision()
          const sessionId = props.sessionId
          const t = translate
          const anchorRef = React.useRef(null)
          const panelRef = React.useRef(null)
          const rowsRef = React.useRef(null)
          const [value, setValue] = React.useState(null)
          const [open, setOpen] = React.useState(false)
          const [placement, setPlacement] = React.useState(null)
          const [now, setNow] = React.useState(() => Date.now())
          const [fade, setFade] = React.useState(false)

          React.useEffect(() => {
            if (!sessionId) return undefined
            let cancelled = false
            const load = async () => {
              try {
                const next = await request(sessionId)
                if (!cancelled) setValue(next)
              } catch {
                if (!cancelled) setValue(null)
              }
            }
            let waiting
            const loop = async () => {
              await load()
              while (!cancelled) {
                waiting = new AbortController()
                try {
                  await request(sessionId, { method: 'watch' }, waiting.signal)
                } catch {
                  if (cancelled) return
                  await new Promise((resolve) => setTimeout(resolve, 2000))
                }
                waiting = undefined
                if (cancelled) return
                await load()
              }
            }
            void loop()
            const timer = setInterval(load, 30_000)
            return () => {
              cancelled = true
              waiting?.abort()
              clearInterval(timer)
            }
          }, [sessionId])

          // 走到新数据时先把时钟拨正，否则关着浮层时药丸上的剩余时间会停在旧值。
          React.useEffect(() => {
            setNow(Date.now())
          }, [value])

          const summaryForClock = value?.summary ?? null
          const ticking = open === true
            || (summaryForClock?.phase === 'active' && summaryForClock?.deadline !== null
              && summaryForClock?.deadline !== undefined)

          React.useEffect(() => {
            if (!ticking) return undefined
            const timer = setInterval(() => setNow(Date.now()), 15_000)
            return () => clearInterval(timer)
          }, [ticking])

          // 只有还能往下滚时才显示底部渐隐；滚到底或内容不够高时关掉。
          React.useEffect(() => {
            if (!open) {
              setFade(false)
              return undefined
            }
            const element = rowsRef.current
            if (element === null) return undefined
            const update = () => {
              const overflowing = element.scrollHeight > element.clientHeight + 1
              const atBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 1
              setFade(overflowing && !atBottom)
            }
            update()
            element.addEventListener('scroll', update, { passive: true })
            const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
            observer?.observe(element)
            return () => {
              element.removeEventListener('scroll', update)
              observer?.disconnect()
            }
          }, [open, value, placement !== null])

          const place = React.useCallback(() => {
            const anchor = anchorRef.current
            if (anchor === null) return
            const rect = anchor.getBoundingClientRect()
            const width = Math.min(400, window.innerWidth - 24)
            const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
            const bottom = Math.max(12, window.innerHeight - rect.top + 8)
            setPlacement({ left, bottom, width })
          }, [])

          React.useEffect(() => {
            if (!open) return undefined
            place()
            const inside = (target) => (anchorRef.current?.contains(target) === true)
              || (panelRef.current?.contains(target) === true)
            const onKeydown = (event) => {
              if (event.key === 'Escape') setOpen(false)
            }
            const onPointerDown = (event) => {
              if (!inside(event.target)) setOpen(false)
            }
            document.addEventListener('keydown', onKeydown)
            document.addEventListener('pointerdown', onPointerDown, true)
            window.addEventListener('resize', place)
            window.addEventListener('scroll', place, true)
            return () => {
              document.removeEventListener('keydown', onKeydown)
              document.removeEventListener('pointerdown', onPointerDown, true)
              window.removeEventListener('resize', place)
              window.removeEventListener('scroll', place, true)
            }
          }, [open, place])

          if (value?.enabled !== true) return null
          const summary = value.summary ?? null

          const versions = summary?.versions ?? []
          const latest = versions.length > 0 ? versions[versions.length - 1].version : null
          const phase = summary?.phase ?? 'idle'
          const remainingMs = summary === null || summary.deadline === null || summary.deadline === undefined
            ? null
            : Math.max(0, Number(summary.deadline) - now)
          const statusWord = summary === null
            ? t('idle')
            : phase === 'active'
              ? (remainingMs === null ? t('active') : formatDuration(remainingMs))
              : t(phase)
          const used = summary === null || summary.budgetMs === null || summary.budgetMs === undefined
            ? null
            : Math.min(1, Math.max(0, 1 - (remainingMs ?? 0) / Number(summary.budgetMs)))

          const relative = (stamp) => {
            if (typeof stamp !== 'number' || !Number.isFinite(stamp)) return ''
            const delta = Math.max(0, now - stamp)
            const minutes = Math.floor(delta / 60000)
            if (minutes < 1) return t('justNow')
            if (minutes < 60) return `${minutes} ${t('minutes')}`
            return `${Math.floor(minutes / 60)} ${t('hours')}`
          }

          const chip = h('span', { className: 'ldv-anchor', ref: anchorRef },
            h('button', {
              className: 'ldv-pill',
              type: 'button',
              'aria-expanded': open,
              'aria-label': t('open'),
              title: summary?.objective ?? t('open'),
              onClick: () => setOpen((current) => !current),
            },
            glyph(),
            h('span', { className: 'ldv-label' }, latest === null ? statusWord : `v${latest} · ${statusWord}`)))

          if (!open || placement === null) return chip

          const title = h('div', { className: 'ldv-title' },
            h('span', { className: 'ldv-title-name', title: summary?.objective ?? '' }, summary?.objective ?? t('open')),
            h('span', { className: 'ldv-title-value' }, statusWord))

          const bar = phase === 'active' && used !== null
            ? h('div', { className: 'ldv-bar' }, h('div', { className: 'ldv-bar-fill', style: { width: `${Math.round(used * 100)}%` } }))
            : null

          const rows = versions.length === 0
            ? h('div', { className: 'ldv-note' }, t('empty'))
            : h('div', {
              ref: rowsRef,
              className: fade ? 'ldv-rows is-fade' : 'ldv-rows',
            },
            versions.slice().reverse().map((item) => h('div', {
              key: item.version,
              className: 'ldv-row',
              title: [item.label, item.summary, `${item.files} ${t('files')} · ${formatBytes(item.bytes)}`].filter(Boolean).join('\n'),
            },
            h('span', { className: 'ldv-node' }),
            h('span', { className: 'ldv-vn' }, `v${item.version}`),
            h('span', { className: 'ldv-name' }, item.label ?? item.summary),
            h('span', { className: 'ldv-time' }, relative(item.createdAt)))))

          const pop = h('div', {
            className: 'ldv-pop',
            ref: panelRef,
            style: { left: `${placement.left}px`, bottom: `${placement.bottom}px`, width: `${placement.width}px` },
            role: 'dialog',
            'aria-label': summary?.objective ?? t('open'),
          },
          summary === null
            ? h('div', { className: 'ldv-note' }, t('empty'))
            : [title, bar, rows])

          return h(React.Fragment, null, chip, ReactDOM.createPortal(pop, document.body))
        }

        ctx.slots.inject(SLOT, () => ctx.slots.register({
          name: SLOT,
          id: 'live-delivery',
          order: 2,
          // dock 槽位以空 props 渲染；会话 id 只能经注册项的 inject 注入
          // （与内置 conversation.composer.bar / activity 药丸同一机制）。
          inject: (sessionId) => ({ sessionId }),
        }, Panel))
      },
    }
  },
})
