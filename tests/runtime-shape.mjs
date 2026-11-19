/**
 * 用运行中安装里的真实 dsh-tools 校验工具定义形状：
 * output.schema 是否受支持、parameters DSL 是否可编译、defineTool 是否接受。
 * 运行（必须用 DSH 的 Electron 运行时，才能读 app.asar）：
 *   $env:ELECTRON_RUN_AS_NODE=1; & $env:DSH_NODE_EXECUTABLE tests/runtime-shape.mjs
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import { apply } from '../index.js'

const require = createRequire(import.meta.url)
const installDir = process.env.DSH_INSTALL_DIR
assert.ok(installDir, '需要 DSH_INSTALL_DIR')
const toolsLib = require(path.resolve(installDir, '..', 'dsh-tools', 'lib', 'index.js'))
const { assertSupportedJsonSchema, parameterSchemaSpecToJsonSchema, projectToolSchema, validateArgs, defineTool } = toolsLib

const tools = []
const ctx = {
  logger: { warn() {}, info() {} },
  effect(fn) { return fn() },
  on() { return () => {} },
  get() { return undefined },
  inject(_names, callback) {
    return callback({ get: () => undefined, effect: (fn) => fn() })
  },
  tools: { register(definition) { tools.push(definition); return () => {} } },
  commands: { register() { return () => {} } },
  skills: { register() { return () => {} } },
  systemPrompt: { section() { return () => {} } },
  workingDirectory: { get() { return process.cwd() } },
}

apply(ctx, {})

const samples = {
  ld_begin: { goal: 'demo', budget: '1m', plan: 'p' },
  ld_publish: { summary: 's', files: ['a.js'], label: 'v1' },
  ld_status: {},
  ld_done: { summary: 's', outcome: 'complete' },
}

for (const tool of tools) {
  assertSupportedJsonSchema(tool.output.schema)
  const parameters = parameterSchemaSpecToJsonSchema(tool.parameters)
  assert.equal(parameters.type, 'object')
  assert.ok(parameters.properties, `${tool.name} 应有 properties`)
  projectToolSchema(tool)
  validateArgs(tool.parameters, samples[tool.name])
  const wrapped = defineTool(tool)
  assert.equal(wrapped.name, tool.name)
  console.log(`ok ${tool.name}: ${Object.keys(parameters.properties).join(', ') || '(no params)'}`)
}

console.log('live-delivery runtime shape: OK')
