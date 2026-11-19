/**
 * 状态机与开关自测：不装 profile，用 mock ctx 直接驱动 apply()。
 * 运行：node tests/state.spec.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const followups = []

/**
 * 构造最小可用的 Host ctx 替身，并捕获面板路由。
 * @returns {any} 测试上下文与记录。
 */
function makeCtx(registry = new Map()) {
  const tools = []
  const toolOptions = new Map()
  const commands = []
  const sections = []
  const handlers = []
  let route
  const connection = {
    fetch: {
      register(definition) {
        route = definition
        return () => { route = undefined }
      },
    },
  }
  const ctx = {
    logger: { warn() {}, info() {} },
    effect(fn) { return fn() },
    on(event, handler) { handlers.push({ event, handler }); return () => {} },
    get(name) {
      if (name === 'agents') return { get: (id) => registry.get(id) }
      if (name === 'sessions') return { get: () => undefined }
      return undefined
    },
    inject(names, callback) {
      if (names.includes('connection')) {
        return callback({ get: (name) => (name === 'connection' ? connection : undefined), effect: (fn) => fn() })
      }
      return callback({ get: () => undefined, effect: (fn) => fn() })
    },
    tools: {
      register(definition, options) {
        tools.push(definition)
        toolOptions.set(definition.name, options)
        return () => {}
      },
    },
    skills: { register() { return () => {} } },
    commands: { register(definition) { commands.push(definition); return () => {} } },
    systemPrompt: { section(section) { sections.push(section); return () => {} } },
    workingDirectory: { get(session) { return session.cwd } },
  }
  return { ctx, tools, toolOptions, commands, sections, handlers, registry, routeOf: () => route }
}

/**
 * 造一个 agent 替身。
 * @param {string} cwd - 当前工作目录。
 * @param {string} id - 会话 id。
 * @param {string} [originCwd] - 会话创建时的工作目录（状态锚点），默认同 cwd。
 * @returns {any} agent。
 */
function makeAgent(cwd, id = 'sess-1', originCwd = cwd) {
  const scopedSkills = []
  return {
    id,
    status: 'idle',
    session: { id, cwd, header: { cwd: originCwd } },
    ctx: {
      get(name) {
        if (name !== 'skills') return undefined
        return { register(skill) { scopedSkills.push(skill); return () => {} } }
      },
    },
    scopedSkills,
    followup(message) { followups.push(message) },
  }
}

/**
 * 取工具定义。
 * @param {any[]} tools - 已注册工具。
 * @param {string} name - 工具名。
 * @returns {any} 工具定义。
 */
function toolOf(tools, name) {
  const found = tools.find(item => item.name === name)
  assert.ok(found, `缺少工具 ${name}`)
  return found
}

/**
 * 执行一个工具。
 * @param {any[]} tools - 已注册工具。
 * @param {string} name - 工具名。
 * @param {Record<string, unknown>} args - 参数。
 * @param {any} agent - 调用方。
 * @returns {Promise<any>} 结果值。
 */
async function call(tools, name, args, agent) {
  return toolOf(tools, name).execute(args, {
    agent,
    signal: new AbortController().signal,
  })
}

/**
 * 执行 /deliver 命令切换开关。
 * @param {any} harness - makeCtx 的返回。
 * @param {any} agent - 会话。
 * @param {string} rawInput - 命令文本（空表示切换）。
 * @returns {any} 命令结果。
 */
function deliver(harness, agent, rawInput = '') {
  const definition = harness.commands.find(item => item.name === 'deliver')
  assert.ok(definition, '应注册 /deliver 命令')
  return definition.handler({ agent, rawInput, attachments: [], signal: new AbortController().signal })
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-state-'))
const project = path.join(root, 'project')
fs.mkdirSync(project, { recursive: true })
fs.writeFileSync(path.join(project, 'index.html'), '<!doctype html><h1>v1</h1>')
fs.writeFileSync(path.join(project, 'app.js'), 'console.log(1)\n')

// 1. 注册成果：4 个工具带 when、1 段提示词、没有全局技能
const harness = makeCtx()
const { ctx, tools, toolOptions, sections, handlers } = harness
apply(ctx, {})
assert.deepEqual(tools.map(item => item.name).sort(), ['ld_begin', 'ld_done', 'ld_publish', 'ld_status'])
assert.equal(sections.length, 1)
for (const name of ['ld_begin', 'ld_publish', 'ld_status', 'ld_done']) {
  assert.equal(typeof toolOptions.get(name)?.when, 'function', `${name} 应带 when 条件`)
}

const agent = makeAgent(project)
harness.registry.set(agent.session.id, agent)

// 2. 默认关闭
assert.equal(await toolOptions.get('ld_begin').when({ agent }), false)
assert.equal(agent.scopedSkills.length, 0)
assert.equal(sections[0].text({ agent }), '')
const enabledFile = path.join(project, '.live-delivery', 'sess-1', 'enabled.json')
assert.equal(fs.existsSync(enabledFile), false, '未开启时不应写开关文件')

// 3. /deliver 开启
const on = deliver(harness, agent)
assert.equal(on.kind, 'success')
assert.equal(await toolOptions.get('ld_begin').when({ agent }), true)
assert.equal(agent.scopedSkills.length, 1)
assert.equal(JSON.parse(fs.readFileSync(enabledFile, 'utf8')).enabled, true)

// 4. 任务链路
const begun = await call(tools, 'ld_begin', { goal: '单摆实验页', budget: '30m' }, agent)
assert.equal(begun.phase, 'active')
assert.ok(begun.remainingMs > 29 * 60_000 && begun.remainingMs <= 30 * 60_000)
assert.match(sections[0].text({ agent }), /单摆实验页/)
await assert.rejects(() => call(tools, 'ld_begin', { goal: '又一个' }, agent), /已有进行中的交付任务/)

const v1 = await call(tools, 'ld_publish', { summary: '静态页面，手动打开验证', label: '骨架' }, agent)
assert.equal(v1.lastVersion.version, 1)
assert.equal(v1.lastVersion.entry, 'index.html')
assert.equal(v1.lastVersion.files, 2)

fs.writeFileSync(path.join(project, 'app.js'), 'console.log(2)\n')
const v2 = await call(tools, 'ld_publish', { summary: '加交互', files: ['index.html', 'app.js'] }, agent)
assert.equal(v2.lastVersion.version, 2)
assert.ok(fs.existsSync(path.join(v1.lastVersion.path, 'app.js')), '旧版本必须保留')
await assert.rejects(() => call(tools, 'ld_publish', { summary: '越界', files: ['../escape.txt'] }, agent), /项目目录内/)
await assert.rejects(() => call(tools, 'ld_publish', { summary: '缺失', files: ['nope.txt'] }, agent), /找不到文件：nope\.txt/)

const status = await call(tools, 'ld_status', {}, agent)
assert.equal(status.active, true)
assert.equal(status.versionCount, 2)

// 5. 关闭：开关变 false、任务停止、技能撤销
const off = deliver(harness, agent, 'off')
assert.equal(off.kind, 'success')
assert.equal(await toolOptions.get('ld_begin').when({ agent }), false)
assert.equal(sections[0].text({ agent }), '')
const afterClose = await call(tools, 'ld_status', {}, agent)
assert.equal(afterClose.phase, 'stopped')
assert.equal(afterClose.active, false)

// 6. 重新开启后可开新任务并收尾
const again = deliver(harness, agent)
assert.equal(again.kind, 'success')
await call(tools, 'ld_begin', { goal: '第二个任务', budget: '5m' }, agent)
const done = await call(tools, 'ld_done', { summary: '收尾', outcome: 'complete' }, agent)
assert.equal(done.phase, 'complete')

// 7. 自动续轮只在开启时触发
followups.length = 0
const auto = makeCtx()
apply(auto.ctx, { autoContinue: true, maxAutoRounds: 2 })
const autoAgent = makeAgent(project, 'sess-auto')
auto.registry.set(autoAgent.session.id, autoAgent)
const onStatus = auto.handlers.find(item => item.event === 'agent/status').handler
await call(auto.tools, 'ld_begin', { goal: '自动续轮', budget: '1h' }, autoAgent)
await call(auto.tools, 'ld_publish', { summary: '第一版' }, autoAgent)
onStatus({ agent: autoAgent, status: 'idle' })
assert.equal(followups.length, 0, '未开启时不应自动续轮')

deliver(auto, autoAgent)
onStatus({ agent: autoAgent, status: 'idle' })
assert.equal(followups.length, 1, '开启且空闲后应追加一轮')

const stateFile = path.join(project, '.live-delivery', 'sess-auto', 'state.json')
for (let index = 0; index < 4; index++) {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  state.lastAutoAt = 0
  fs.writeFileSync(stateFile, JSON.stringify(state))
  onStatus({ agent: autoAgent, status: 'idle' })
}
assert.equal(followups.length, 2, `自动续轮应止于 maxAutoRounds，实际 ${followups.length}`)

// 发布不会重置续轮上限
await call(auto.tools, 'ld_publish', { summary: '再交一版' }, autoAgent)
{
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  state.lastAutoAt = 0
  fs.writeFileSync(stateFile, JSON.stringify(state))
}
onStatus({ agent: autoAgent, status: 'idle' })
assert.equal(followups.length, 2, '发布后不应重置续轮上限')

// 8. dir 只改快照来源，状态仍在会话目录
const sessionCwd = path.join(root, 'session-cwd')
const sourceDir = path.join(sessionCwd, 'site')
fs.mkdirSync(sourceDir, { recursive: true })
fs.writeFileSync(path.join(sourceDir, 'index.html'), '<!doctype html><h1>dir</h1>')
const dirHarness = makeCtx()
apply(dirHarness.ctx, {})
const dirAgent = makeAgent(sessionCwd, 'sess-dir')
dirHarness.registry.set(dirAgent.session.id, dirAgent)
deliver(dirHarness, dirAgent)
const dirBegin = await call(dirHarness.tools, 'ld_begin', { goal: 'dir 语义', dir: 'site' }, dirAgent)
assert.ok(dirBegin.stateFile.startsWith(path.join(sessionCwd, '.live-delivery')), '状态应落在会话目录')
assert.equal(dirBegin.cwd, sourceDir)
const dirPublish = await call(dirHarness.tools, 'ld_publish', { summary: '来自子目录' }, dirAgent)
assert.equal(dirPublish.lastVersion.files, 1)

// 9. 快照上限
const cappedProject = path.join(root, 'capped')
fs.mkdirSync(cappedProject, { recursive: true })
fs.writeFileSync(path.join(cappedProject, 'index.html'), '<!doctype html><h1>a</h1>')
fs.writeFileSync(path.join(cappedProject, 'b.js'), 'console.log(1)\n')
const capped = makeCtx()
apply(capped.ctx, { snapshot: { maxFiles: 1 } })
const cappedAgent = makeAgent(cappedProject, 'sess-capped')
capped.registry.set(cappedAgent.session.id, cappedAgent)
deliver(capped, cappedAgent)
await call(capped.tools, 'ld_begin', { goal: '截断' }, cappedAgent)
const cappedResult = await call(capped.tools, 'ld_publish', { summary: '只留一个文件' }, cappedAgent)
assert.equal(cappedResult.lastVersion.files, 1)
assert.equal(cappedResult.lastVersion.truncated, true)

// 10. 第二个任务会把上一轮版本归档，不覆盖
const reuseProject = path.join(root, 'reuse')
fs.mkdirSync(reuseProject, { recursive: true })
fs.writeFileSync(path.join(reuseProject, 'a.txt'), 'one')
const reuse = makeCtx()
apply(reuse.ctx, {})
const reuseAgent = makeAgent(reuseProject, 'sess-reuse')
reuse.registry.set('sess-reuse', reuseAgent)
deliver(reuse, reuseAgent)
await call(reuse.tools, 'ld_begin', { goal: '第一轮', budget: '5m' }, reuseAgent)
await call(reuse.tools, 'ld_publish', { summary: '第一版' }, reuseAgent)
await call(reuse.tools, 'ld_done', { summary: '结束', outcome: 'complete' }, reuseAgent)
fs.writeFileSync(path.join(reuseProject, 'a.txt'), 'two')
await call(reuse.tools, 'ld_begin', { goal: '第二轮', budget: '5m' }, reuseAgent)
const secondPublish = await call(reuse.tools, 'ld_publish', { summary: '第二版' }, reuseAgent)
const archiveRoot = path.join(reuseProject, '.live-delivery', 'sess-reuse', 'archive')
const archived = fs.readdirSync(archiveRoot, { recursive: true }).filter(item => String(item).endsWith('a.txt'))
assert.equal(archived.length, 1, '上一轮快照应归档')
assert.equal(fs.readFileSync(path.join(archiveRoot, String(archived[0])), 'utf8'), 'one', '归档内容应是上一轮')
assert.equal(fs.readFileSync(path.join(secondPublish.lastVersion.path, 'a.txt'), 'utf8'), 'two', '新版本应是新内容')

// 11. 同名残留目录在交付前被清掉
const staleProject = path.join(root, 'stale')
fs.mkdirSync(path.join(staleProject, 'keep'), { recursive: true })
fs.writeFileSync(path.join(staleProject, 'keep', 'b.txt'), 'b')
const stale = makeCtx()
apply(stale.ctx, {})
const staleAgent = makeAgent(staleProject, 'sess-stale')
stale.registry.set('sess-stale', staleAgent)
deliver(stale, staleAgent)
await call(stale.tools, 'ld_begin', { goal: '残留', budget: '5m' }, staleAgent)
const staleVersionDir = path.join(staleProject, '.live-delivery', 'sess-stale', 'versions', 'v001')
fs.mkdirSync(staleVersionDir, { recursive: true })
fs.writeFileSync(path.join(staleVersionDir, 'junk.txt'), 'junk')
const cleanPublish = await call(stale.tools, 'ld_publish', { summary: '干净的一版' }, staleAgent)
assert.equal(fs.existsSync(path.join(staleVersionDir, 'junk.txt')), false, '残留文件应被清掉')
assert.ok(fs.existsSync(path.join(cleanPublish.lastVersion.path, 'keep', 'b.txt')))

// 12. 状态锚在会话创建目录：切到别的工作目录仍能找到任务
const otherDir = path.join(root, 'other')
fs.mkdirSync(otherDir, { recursive: true })
const cdHarness = makeCtx()
apply(cdHarness.ctx, {})
const cdAgent = makeAgent(otherDir, 'sess-cd', project)
cdHarness.registry.set('sess-cd', cdAgent)
deliver(cdHarness, cdAgent)
const cdBegin = await call(cdHarness.tools, 'ld_begin', { goal: '切目录', budget: '5m' }, cdAgent)
assert.ok(cdBegin.stateFile.startsWith(path.join(project, '.live-delivery')), '状态应锚在会话创建目录')
const cdStatus = await call(cdHarness.tools, 'ld_status', {}, cdAgent)
assert.equal(cdStatus.taskId !== undefined, true, '切目录后仍应找到任务')

// 13. glob 忽略规则
const globProject = path.join(root, 'glob')
fs.mkdirSync(path.join(globProject, 'gen'), { recursive: true })
fs.mkdirSync(path.join(globProject, 'keep'), { recursive: true })
fs.writeFileSync(path.join(globProject, 'gen', 'a.txt'), 'a')
fs.writeFileSync(path.join(globProject, 'keep', 'b.txt'), 'b')
const globHarness = makeCtx()
apply(globHarness.ctx, { snapshot: { ignore: ['gen/**'] } })
const globAgent = makeAgent(globProject, 'sess-glob')
globHarness.registry.set('sess-glob', globAgent)
deliver(globHarness, globAgent)
await call(globHarness.tools, 'ld_begin', { goal: 'glob', budget: '5m' }, globAgent)
const globPublished = await call(globHarness.tools, 'ld_publish', { summary: '忽略 gen' }, globAgent)
assert.equal(globPublished.lastVersion.files, 1)
assert.equal(fs.existsSync(path.join(globPublished.lastVersion.path, 'gen')), false)
assert.ok(fs.existsSync(path.join(globPublished.lastVersion.path, 'keep', 'b.txt')))

// 14. 截断与状态回执
const cappedText = toolOf(capped.tools, 'ld_publish').output.render({}, cappedResult).map(block => block.text).join('\n')
assert.match(cappedText, /已截断/)
const statusText = toolOf(tools, 'ld_status').output.render({}, status).map(block => block.text).join('\n')
assert.match(statusText, /v1/)
assert.match(statusText, /\.live-delivery/)
const beginText = toolOf(tools, 'ld_begin').output.render({}, begun).map(block => block.text).join('\n')
assert.match(beginText, /状态文件/)

// 15. 坏预算不应先归档旧版本
const archiveProject = path.join(root, 'archive-safe')
fs.mkdirSync(archiveProject, { recursive: true })
fs.writeFileSync(path.join(archiveProject, 'a.txt'), 'a')
const safeHarness = makeCtx()
apply(safeHarness.ctx, {})
const safeAgent = makeAgent(archiveProject, 'sess-safe')
safeHarness.registry.set('sess-safe', safeAgent)
deliver(safeHarness, safeAgent)
await call(safeHarness.tools, 'ld_begin', { goal: '归档安全', budget: '5m' }, safeAgent)
const safePublish = await call(safeHarness.tools, 'ld_publish', { summary: '一版' }, safeAgent)
await call(safeHarness.tools, 'ld_done', { summary: '结束', outcome: 'complete' }, safeAgent)
await assert.rejects(() => call(safeHarness.tools, 'ld_begin', { goal: '再来', budget: 'abc' }, safeAgent), /无法解析预算/)
assert.ok(fs.existsSync(path.join(safePublish.lastVersion.path, 'a.txt')), '坏预算不应移动旧快照')
const safeStatus = await call(safeHarness.tools, 'ld_status', {}, safeAgent)
const safeText = toolOf(safeHarness.tools, 'ld_status').output.render({}, safeStatus).map(block => block.text).join('\n')
assert.match(safeText, /已结束/)
assert.match(safeText, /v1/)

// 16. 失败发布不留下空版本目录
const emptyPublishProject = path.join(root, 'empty-publish')
fs.mkdirSync(emptyPublishProject, { recursive: true })
fs.writeFileSync(path.join(emptyPublishProject, 'b.txt'), 'b')
const emptyHarness = makeCtx()
apply(emptyHarness.ctx, {})
const emptyAgent = makeAgent(emptyPublishProject, 'sess-empty')
emptyHarness.registry.set('sess-empty', emptyAgent)
deliver(emptyHarness, emptyAgent)
await call(emptyHarness.tools, 'ld_begin', { goal: '失败发布', budget: '5m' }, emptyAgent)
await assert.rejects(() => call(emptyHarness.tools, 'ld_publish', { summary: '缺文件', files: ['missing.txt'] }, emptyAgent), /找不到文件/)
const emptyVersion = path.join(emptyPublishProject, '.live-delivery', 'sess-empty', 'versions', 'v001')
assert.equal(fs.existsSync(emptyVersion), false, '失败发布不应留下空版本目录')

// 17. 根目录入口优先，dist 不再默认忽略
const entryProject = path.join(root, 'entry')
fs.mkdirSync(path.join(entryProject, 'docs'), { recursive: true })
fs.mkdirSync(path.join(entryProject, 'dist'), { recursive: true })
fs.writeFileSync(path.join(entryProject, 'index.html'), '<h1>root</h1>')
fs.writeFileSync(path.join(entryProject, 'docs', 'index.html'), '<h1>docs</h1>')
fs.writeFileSync(path.join(entryProject, 'dist', 'app.js'), 'x')
const entryHarness = makeCtx()
apply(entryHarness.ctx, {})
const entryAgent = makeAgent(entryProject, 'sess-entry')
entryHarness.registry.set('sess-entry', entryAgent)
deliver(entryHarness, entryAgent)
await call(entryHarness.tools, 'ld_begin', { goal: '入口优先', budget: '5m' }, entryAgent)
const entryPublished = await call(entryHarness.tools, 'ld_publish', { summary: '多入口' }, entryAgent)
assert.equal(entryPublished.lastVersion.entry, 'index.html')
assert.ok(fs.existsSync(path.join(entryPublished.lastVersion.path, 'dist', 'app.js')), 'dist 不应被默认忽略')

// 18. 全部被忽略时，报错指向忽略规则
const ignoredProject = path.join(root, 'ignored')
fs.mkdirSync(path.join(ignoredProject, 'node_modules'), { recursive: true })
fs.writeFileSync(path.join(ignoredProject, 'node_modules', 'x.js'), 'x')
const ignoredHarness = makeCtx()
apply(ignoredHarness.ctx, {})
const ignoredAgent = makeAgent(ignoredProject, 'sess-ignored')
ignoredHarness.registry.set('sess-ignored', ignoredAgent)
deliver(ignoredHarness, ignoredAgent)
await call(ignoredHarness.tools, 'ld_begin', { goal: '全被忽略', budget: '5m' }, ignoredAgent)
await assert.rejects(
  () => call(ignoredHarness.tools, 'ld_publish', { summary: '空' }, ignoredAgent),
  /忽略规则/,
)

// 19. 预算用尽后的回执明确要求收尾
const spentProject = path.join(root, 'spent')
fs.mkdirSync(spentProject, { recursive: true })
fs.writeFileSync(path.join(spentProject, 'a.txt'), 'a')
const spentHarness = makeCtx()
apply(spentHarness.ctx, {})
const spentAgent = makeAgent(spentProject, 'sess-spent')
spentHarness.registry.set('sess-spent', spentAgent)
deliver(spentHarness, spentAgent)
await call(spentHarness.tools, 'ld_begin', { goal: '预算用尽', budget: '1m' }, spentAgent)
const spentStateFile = path.join(spentProject, '.live-delivery', 'sess-spent', 'state.json')
const spentState = JSON.parse(fs.readFileSync(spentStateFile, 'utf8'))
spentState.deadline = Date.now() - 1000
fs.writeFileSync(spentStateFile, JSON.stringify(spentState))
const spentPublish = await call(spentHarness.tools, 'ld_publish', { summary: '超时发布' }, spentAgent)
const spentText = toolOf(spentHarness.tools, 'ld_publish').output.render({}, spentPublish).map(block => block.text).join('\n')
assert.match(spentText, /预算已用尽/)

// 20. 长轮询在状态落盘时立即返回
{
  const route = harness.routeOf()
  const started = Date.now()
  const watching = route.fetch(new Request('http://127.0.0.1/api/live-delivery/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'sess-1', method: 'watch' }),
  }))
  await new Promise(resolve => setTimeout(resolve, 50))
  await call(tools, 'ld_begin', { goal: '轮询唤醒', budget: '1m' }, agent)
  const watched = await (await watching).json()
  assert.equal(watched.value.changed, true)
  assert.ok(Date.now() - started < 2000, '长轮询应被落盘立即唤醒')
}

// 21. 未知会话与坏请求
const missing = await (async () => {
  const response = await harness.routeOf().fetch(new Request('http://127.0.0.1/api/live-delivery/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'nope', method: 'state' }),
  }))
  return response.json()
})()
assert.equal(missing.error.code, 'session-not-live')

// 22. 自动续轮的边界：没有版本、剩余预算不足、任务已结束都不拉起
followups.length = 0
const edgeProject = path.join(root, 'auto-edge')
fs.mkdirSync(edgeProject, { recursive: true })
fs.writeFileSync(path.join(edgeProject, 'index.html'), '<!doctype html><h1>edge</h1>')
const edgeHarness = makeCtx()
apply(edgeHarness.ctx, { autoContinue: true, maxAutoRounds: 5 })
const edgeAgent = makeAgent(edgeProject, 'sess-edge')
edgeHarness.registry.set(edgeAgent.session.id, edgeAgent)
deliver(edgeHarness, edgeAgent)
const edgeStatus = edgeHarness.handlers.find(item => item.event === 'agent/status').handler
await call(edgeHarness.tools, 'ld_begin', { goal: '续轮边界', budget: '1h' }, edgeAgent)
edgeStatus({ agent: edgeAgent, status: 'idle' })
assert.equal(followups.length, 0, '还没有版本时不应续轮')
await call(edgeHarness.tools, 'ld_publish', { summary: '第一版' }, edgeAgent)
const edgeFile = path.join(edgeProject, '.live-delivery', 'sess-edge', 'state.json')
{
  const state = JSON.parse(fs.readFileSync(edgeFile, 'utf8'))
  state.deadline = Date.now() + 30_000
  state.lastAutoAt = 0
  fs.writeFileSync(edgeFile, JSON.stringify(state))
}
edgeStatus({ agent: edgeAgent, status: 'idle' })
assert.equal(followups.length, 0, '剩余预算不足 60 秒时不应续轮')
await call(edgeHarness.tools, 'ld_done', { summary: '收尾' }, edgeAgent)
edgeStatus({ agent: edgeAgent, status: 'idle' })
assert.equal(followups.length, 0, '任务结束后不应续轮')

// 23. 空白 goal 直接拒绝，且不留下状态
const blankProject = path.join(root, 'blank-goal')
fs.mkdirSync(blankProject, { recursive: true })
const blankHarness = makeCtx()
apply(blankHarness.ctx, {})
const blankAgent = makeAgent(blankProject, 'sess-blank')
blankHarness.registry.set(blankAgent.session.id, blankAgent)
deliver(blankHarness, blankAgent)
await assert.rejects(() => call(blankHarness.tools, 'ld_begin', { goal: '   ' }, blankAgent), /goal 不能为空/)
assert.equal(
  fs.existsSync(path.join(blankProject, '.live-delivery', 'sess-blank', 'state.json')),
  false,
  '参数被拒时不应写状态文件',
)

// 24. 空白 label 归一成 null，不留空标签
const labelProject = path.join(root, 'label')
fs.mkdirSync(labelProject, { recursive: true })
fs.writeFileSync(path.join(labelProject, 'a.txt'), 'a')
const labelHarness = makeCtx()
apply(labelHarness.ctx, {})
const labelAgent = makeAgent(labelProject, 'sess-label')
labelHarness.registry.set(labelAgent.session.id, labelAgent)
deliver(labelHarness, labelAgent)
await call(labelHarness.tools, 'ld_begin', { goal: '标签归一', budget: '5m' }, labelAgent)
const labelPublished = await call(labelHarness.tools, 'ld_publish', { summary: '没写标签', label: '   ' }, labelAgent)
assert.equal(labelPublished.lastVersion.label, null)
const labelText = toolOf(labelHarness.tools, 'ld_status').output.render({}, labelPublished).map(block => block.text).join('\n')
assert.match(labelText, /任务：进行中/)

fs.rmSync(root, { recursive: true, force: true })
console.log('live-delivery state tests: OK')

