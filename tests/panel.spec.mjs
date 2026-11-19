/**
 * 面板数据桥自测：用 mock connection 捕获 Host 路由，校验开关与摘要返回。
 * 运行：node tests/panel.spec.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-panel-'))
const project = path.join(root, 'project')
fs.mkdirSync(project, { recursive: true })
fs.writeFileSync(path.join(project, 'index.html'), '<!doctype html><h1>panel</h1>')
fs.writeFileSync(path.join(project, 'app.js'), 'console.log("panel")')

let route
const connection = {
  fetch: {
    register(definition) {
      route = definition
      return () => { route = undefined }
    },
  },
}

const session = { id: 'sess-panel', cwd: project }
const skills = []
const agent = {
  id: 'sess-panel',
  status: 'idle',
  session,
  ctx: {
    get(name) {
      if (name !== 'skills') return undefined
      return { register(skill) { skills.push(skill); return () => {} } }
    },
  },
  followup() {},
}
const others = new Map([['sess-panel', agent]])

const state = { tools: [], commands: [] }
const ctx = {
  logger: { warn() {}, info() {} },
  effect(fn) { return fn() },
  on() { return () => {} },
  get(name) {
    if (name === 'agents') return { get: (id) => others.get(id) }
    if (name === 'sessions') return { get: (id) => (id === 'sess-panel' ? session : undefined) }
    return undefined
  },
  inject(_names, callback) {
    return callback({
      get: (name) => (name === 'connection' ? connection : ctx.get(name)),
      effect: (fn) => fn(),
    })
  },
  tools: { register(definition) { state.tools.push(definition); return () => {} } },
  commands: { register(definition) { state.commands.push(definition); return () => {} } },
  skills: { register() { return () => {} } },
  systemPrompt: { section() { return () => {} } },
  workingDirectory: { get: () => project },
}

apply(ctx, {})
assert.ok(route, '应注册面板路由')
assert.equal(route.path, '/api/live-delivery/query')

const call = async (body) => {
  const response = await route.fetch(new Request('http://127.0.0.1/api/live-delivery/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  assert.ok(response instanceof Response)
  return response.json()
}

// 默认关闭：返回 enabled=false、summary=null，工具不可用
const closed = await call({ sessionId: 'sess-panel', method: 'state' })
assert.equal(closed.ok, true)
assert.equal(closed.value.enabled, false)
assert.equal(closed.value.summary, null)

// 缺 sessionId / 非存活会话
const bad = await call({ method: 'state' })
assert.equal(bad.error.code, 'bad-request')
const offline = await call({ sessionId: 'nope', method: 'state' })
assert.equal(offline.error.code, 'session-not-live')

// /deliver 打开后建任务并交付
const deliver = (rawInput = '') => state.commands.find((item) => item.name === 'deliver').handler({ agent, rawInput, attachments: [], signal: new AbortController().signal })
deliver()
assert.equal(skills.length, 1, '开启后应向会话注册 live-delivery 技能')
assert.equal(skills[0].name, 'live-delivery')
const exec = { agent, signal: new AbortController().signal }
const tool = (name) => state.tools.find((item) => item.name === name)
await tool('ld_begin').execute({ goal: '面板测试', budget: '10m' }, exec)
await tool('ld_publish').execute({ summary: '首版' }, exec)

const opened = await call({ sessionId: 'sess-panel', method: 'state' })
assert.equal(opened.ok, true)
assert.equal(opened.value.enabled, true)
assert.equal(opened.value.summary.versionCount, 1)
assert.equal(opened.value.summary.versions[0].label, null)
assert.equal(opened.value.summary.phase, 'active')

// 关闭后 summary 保留但 enabled=false（面板据此隐藏），任务标记停止
deliver('off')
const disabled = await call({ sessionId: 'sess-panel', method: 'state' })
assert.equal(disabled.value.enabled, false)
assert.equal(disabled.value.summary.phase, 'stopped')

fs.rmSync(root, { recursive: true, force: true })
console.log('live-delivery panel tests: OK')
