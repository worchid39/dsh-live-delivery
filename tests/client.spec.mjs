/**
 * Client 半的契约自测：不装浏览器，用假 require / document / slots 驱动 client.js。
 * 校验注册项（槽位、id、会话注入）、样式在 apply 内注册并可清理。
 * 运行：node tests/client.spec.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(dir, '..', 'client.js'), 'utf8')

const captured = { registration: null, slots: [], cleanups: [], styles: [] }

const documentStub = {
  head: {
    append(element) {
      captured.styles.push(element)
    },
  },
  createElement(tagName) {
    return {
      tagName,
      dataset: {},
      textContent: '',
      remove() {
        const index = captured.styles.indexOf(this)
        if (index !== -1) captured.styles.splice(index, 1)
      },
    }
  },
}

const ReactStub = {
  createElement: (...args) => ({ args }),
  Fragment: 'Fragment',
  useRef: () => ({ current: null }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useSyncExternalStore: () => 0,
}

const windowStub = {
  __ModuleLoader__: {
    load(registration) {
      captured.registration = registration
    },
  },
}

const sandbox = { window: windowStub, document: documentStub, console }
vm.runInNewContext(source, sandbox)

assert.ok(captured.registration !== null, 'client.js 应向 __ModuleLoader__ 注册')
assert.equal(captured.registration.id, '@0rch1d/dsh-live-delivery')

const moduleExports = captured.registration.factory((id) => {
  if (id === 'react') return ReactStub
  if (id === 'react-dom') return { createPortal: () => null }
  throw new Error(`unexpected require: ${id}`)
})

assert.ok(moduleExports.inject.includes('slots'), '客户端应声明 slots 依赖')

const locale = {
  getSnapshot: () => ({ active: 'zh', revision: 3 }),
  subscribe: () => () => {},
}
const ctx = {
  get(name) {
    return name === 'locale' ? locale : undefined
  },
  effect(fn) {
    const cleanup = fn()
    captured.cleanups.push(cleanup)
    return () => {}
  },
  slots: {
    inject(key, factory) {
      assert.equal(key, 'conversation.composer.dock')
      factory()
    },
    register(options, component) {
      captured.slots.push({ options, component })
      return () => {}
    },
  },
}

moduleExports.apply(ctx)

assert.equal(captured.slots.length, 1, 'apply 应注册一个 dock 槽位组件')
const { options, component } = captured.slots[0]
assert.equal(options.name, 'conversation.composer.dock')
assert.equal(options.id, 'live-delivery')
assert.equal(options.order, 2)
assert.equal(typeof options.inject, 'function', 'dock 槽位必须声明 inject 才会拿到 sessionId')
assert.equal(options.inject('sess-1').sessionId, 'sess-1', 'inject 应把会话 id 注入 props')
assert.equal(typeof component, 'function')

// 样式：在 apply 内注册、卸载时移除，且带去重标记。
assert.equal(captured.styles.length, 1, 'apply 应注入一份样式')
assert.equal(captured.styles[0].dataset.plugin, '@0rch1d/dsh-live-delivery')
assert.equal(captured.cleanups.length, 1)
captured.cleanups[0]()
assert.equal(captured.styles.length, 0, '插件卸载后样式应被移除')

console.log('live-delivery client tests: OK')
