/**
 * dsh-live-delivery —— 长任务“边做边交付”插件（Qwen-Live-Delivery-Plugin 的 DSH 原生适配）。
 *
 * 提供四件事：
 *   1. 四个 Host 工具：ld_begin / ld_publish / ld_status / ld_done，维护交付计划、预算与版本快照；
 *   2. 版本快照：每次交付把项目目录冻结成 `.live-delivery/<sessionId>/versions/vNNN/`，旧版本保留；
 *   3. live-delivery 技能 + 提示词协议：先交最小可用版本，之后一版一版迭代；
 *   4. 可选自动续轮：任务进行中且预算未尽时，在会话空闲后追加一轮继续交付（可配置关闭）。
 *
 * 默认不启用：只有用户在对话里 /deliver 打开后，工具、技能、提示词才对该会话生效。
 * 状态只落盘在工作目录，不写会话事件；进程重启后仍然可读。
 *
 * @module @0rch1d/dsh-live-delivery
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const name = 'live-delivery'

/** 需要的 Host Service；任一缺失时本插件保持 inactive。 */
export const inject = ['tools', 'skills', 'systemPrompt', 'workingDirectory', 'commands']

/** 快照默认忽略的目录/文件名；构建产物目录不默认忽略，交付物常在里面。 */
const DEFAULT_IGNORE = [
  'node_modules', '.git', '.hg', '.svn', '.live-delivery', '.pnpm-store',
  '.venv', 'venv', '__pycache__', '.cache', '.parcel-cache', '.next', '.nuxt',
  '.turbo', '.yarn', '.uv-cache', '.DS_Store', 'Thumbs.db',
]

/** 插件默认配置；cordis.patch.yml 的 config 会按键覆盖。 */
const DEFAULTS = {
  autoContinue: true,
  maxAutoRounds: 6,
  defaultBudget: '30m',
  stateDir: '.live-delivery',
  snapshot: {
    maxFiles: 1500,
    maxBytes: 64 * 1024 * 1024,
    ignore: DEFAULT_IGNORE,
    entry: 'index.html',
  },
}

/** 已知配置键；其余键会被忽略并在日志里提示。 */
const CONFIG_KEYS = ['autoContinue', 'maxAutoRounds', 'defaultBudget', 'stateDir', 'snapshot']
const SNAPSHOT_KEYS = ['maxFiles', 'maxBytes', 'ignore', 'entry']

/**
 * 提示拼错的配置项：DSH 的 config 不做校验，写错键会静默失效。
 * @param {any} ctx - Host 上下文。
 * @param {Record<string, unknown> | undefined} config - 行 config。
 * @returns {void}
 */
function warnUnknownConfig(ctx, config) {
  if (config === null || typeof config !== 'object') return
  const unknown = Object.keys(config).filter(key => !CONFIG_KEYS.includes(key))
  const snapshot = config.snapshot
  if (snapshot !== null && typeof snapshot === 'object') {
    unknown.push(...Object.keys(snapshot).filter(key => !SNAPSHOT_KEYS.includes(key)).map(key => `snapshot.${key}`))
  }
  if (unknown.length === 0) return
  ctx.logger?.warn?.(`live-delivery: 忽略未知配置项 ${unknown.join('、')}。可用键：${CONFIG_KEYS.join('、')}；snapshot 可用 ${SNAPSHOT_KEYS.join('、')}。`)
}

/**
 * 合并调用方配置与默认值。
 * @param {Record<string, unknown> | undefined} config - cordis 行 config。
 * @returns 完整配置。
 */
function normalizeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const snapshot = raw.snapshot && typeof raw.snapshot === 'object' ? raw.snapshot : {}
  return {
    autoContinue: raw.autoContinue !== false,
    maxAutoRounds: Number.isFinite(raw.maxAutoRounds) ? Math.max(0, Number(raw.maxAutoRounds)) : DEFAULTS.maxAutoRounds,
    defaultBudget: typeof raw.defaultBudget === 'string' && raw.defaultBudget.trim() !== ''
      ? raw.defaultBudget
      : DEFAULTS.defaultBudget,
    stateDir: typeof raw.stateDir === 'string' && raw.stateDir.trim() !== '' ? raw.stateDir : DEFAULTS.stateDir,
    snapshot: {
      maxFiles: Number.isFinite(snapshot.maxFiles) ? Math.max(1, Number(snapshot.maxFiles)) : DEFAULTS.snapshot.maxFiles,
      maxBytes: Number.isFinite(snapshot.maxBytes) ? Math.max(1, Number(snapshot.maxBytes)) : DEFAULTS.snapshot.maxBytes,
      ignore: Array.isArray(snapshot.ignore)
        ? [...DEFAULT_IGNORE, ...snapshot.ignore.filter(item => typeof item === 'string')]
        : DEFAULTS.snapshot.ignore,
      entry: typeof snapshot.entry === 'string' && snapshot.entry.trim() !== ''
        ? snapshot.entry
        : DEFAULTS.snapshot.entry,
    },
  }
}

/**
 * 解析 `30m` / `2h` / `45s` / `1d` / `500ms`。
 * @param {string} text - 预算文本。
 * @returns {number | undefined} 毫秒数；空值返回 undefined。
 */
function parseBudget(text) {
  if (text === undefined || text === null) return undefined
  const trimmed = String(text).trim()
  if (trimmed === '') return undefined
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*(ms|s|m|h|d)?$/i.exec(trimmed)
  if (match === null) throw new Error(`无法解析预算 "${text}"：请用 30m / 2h / 1d 这类写法`)
  const value = Number(match[1])
  const unit = (match[2] ?? 'm').toLowerCase()
  const factor = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
  return Math.round(value * factor)
}

/**
 * 把毫秒渲染成紧凑时长。
 * @param {number | null} ms - 毫秒；null 表示不限时。
 * @returns {string} 可读时长。
 */
function formatDuration(ms) {
  if (ms === null) return '不限时'
  if (!Number.isFinite(ms)) return '不限时'
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

/**
 * 会话工作目录下的任务目录。
 * @param {ReturnType<typeof normalizeConfig>} cfg - 插件配置。
 * @param {string} cwd - 会话工作目录。
 * @param {string} sessionId - 会话 id。
 * @returns {string} 任务目录绝对路径。
 */
function taskDirOf(cfg, cwd, sessionId) {
  return path.join(cwd, cfg.stateDir, String(sessionId))
}

/**
 * 读取磁盘上的任务状态。
 * @param {string} stateFile - state.json 路径。
 * @returns {Record<string, any> | undefined} 状态；文件缺失或损坏时 undefined。
 */
function readStateFile(stateFile) {
  let text
  try {
    text = fs.readFileSync(stateFile, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 原子写入状态文件。
 * @param {string} stateFile - state.json 路径。
 * @param {Record<string, unknown>} state - 状态对象。
 * @returns {void}
 */
function writeStateFile(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  // 临时名带随机后缀：并发写入同一会话时不会互相踩掉对方的一半写入。
  const temp = `${stateFile}.${randomUUID()}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, stateFile)
  notifySessionChange(path.basename(path.dirname(stateFile)))
}

/**
 * 解析 Agent 的工作目录。
 * @param {any} ctx - Host 上下文。
 * @param {any} agent - 调用方 Agent。
 * @returns {string} 工作目录。
 */
function cwdOf(ctx, agent) {
  const session = agent?.session
  if (session === undefined) return process.cwd()
  try {
    return ctx.workingDirectory.get(session)
  } catch {
    return process.cwd()
  }
}

/**
 * 状态的锚点目录：会话创建时的工作目录，不随 `cd` 变化。
 * @param {any} ctx - Host 上下文。
 * @param {any} session - 会话。
 * @returns {string} 锚点目录绝对路径。
 */
function anchorCwdOf(ctx, session) {
  const headerCwd = session?.header?.cwd
  if (typeof headerCwd === 'string' && headerCwd !== '') return headerCwd
  return cwdOfSession(ctx, session) ?? process.cwd()
}

/**
 * 读取某个 Agent 当前会话的交付状态。
 * @param {any} ctx - Host 上下文。
 * @param {ReturnType<typeof normalizeConfig>} cfg - 插件配置。
 * @param {any} agent - 调用方 Agent。
 * @returns {{ state?: Record<string, any>, stateFile?: string, cwd: string }} 读取结果。
 */
function loadForAgent(ctx, cfg, agent) {
  const session = agent?.session
  const cwd = anchorCwdOf(ctx, session)
  const sessionId = session?.id
  if (sessionId === undefined) return { cwd }
  const dir = taskDirOf(cfg, cwd, sessionId)
  const stateFile = path.join(dir, 'state.json')
  return { state: readStateFile(stateFile), stateFile, cwd }
}

/**
 * 把 glob 片段编译成正则，支持 `*`（不跨目录）、`**`（跨目录）、`?`。
 * @param {string} pattern - 相对路径模式。
 * @returns {RegExp} 匹配整个相对路径的正则。
 */
function globToRegExp(pattern) {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*'
        index += 1
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`${source}$`)
}

/**
 * 编译忽略规则：不含 `/` 的按目录名/文件名匹配，含 `/` 的按相对路径 glob 匹配。
 * @param {readonly string[]} patterns - 忽略规则。
 * @returns {(relative: string, name: string) => boolean} 判定函数。
 */
function createIgnoreMatcher(patterns) {
  const names = new Set()
  const globs = []
  for (const raw of patterns) {
    const pattern = String(raw).trim()
    if (pattern === '') continue
    if (pattern.includes('/')) globs.push(globToRegExp(pattern.replace(/^\.\//, '')))
    else names.add(pattern)
  }
  return (relative, name) => names.has(name) || globs.some(expression => expression.test(relative))
}

/**
 * 递归复制目录，或只复制显式列出的文件。
 * @param {string} cwd - 源目录。
 * @param {string} dest - 目标目录。
 * @param {{ files?: readonly string[], ignore: readonly string[], maxFiles: number, maxBytes: number, entry: string }} options - 选项。
 * @returns {{ files: number, bytes: number, truncated: boolean, entry: string | null }} 快照统计。
 */
function copySnapshot(cwd, dest, options) {
  const ignored = createIgnoreMatcher(options.ignore)
  const result = { files: 0, bytes: 0, truncated: false, entry: null }
  let exactEntry = null
  let fallbackEntry = null
  let htmlCandidate = null

  const copyOne = (rel) => {
    const source = path.join(cwd, rel)
    let stat
    try {
      stat = fs.statSync(source)
    } catch {
      return
    }
    if (!stat.isFile()) return
    if (result.files >= options.maxFiles || result.bytes + stat.size > options.maxBytes) {
      result.truncated = true
      return
    }
    const target = path.join(dest, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
    result.files += 1
    result.bytes += stat.size
    if (rel === options.entry) exactEntry = rel
    else if (fallbackEntry === null && path.basename(rel) === options.entry) fallbackEntry = rel
    if (rel !== options.entry && htmlCandidate === null && /\.html?$/i.test(rel)) htmlCandidate = rel
  }

  const walk = (rel) => {
    if (result.truncated) return
    const dir = rel === '' ? cwd : path.join(cwd, rel)
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (result.truncated) return
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (ignored(childRel, entry.name)) continue
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        walk(childRel)
        continue
      }
      if (entry.isFile()) copyOne(childRel)
    }
  }

  fs.mkdirSync(dest, { recursive: true })
  const explicit = Array.isArray(options.files) ? options.files.filter(item => typeof item === 'string' && item.trim() !== '') : []
  if (explicit.length > 0) {
    const root = path.resolve(cwd)
    for (const item of explicit) {
      const resolved = path.resolve(root, item)
      const relative = path.relative(root, resolved)
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`files 里的路径必须位于项目目录内：${item}`)
      }
      let stat
      try {
        stat = fs.statSync(resolved)
      } catch {
        throw new Error(`找不到文件：${item}（相对项目目录 ${root}）`)
      }
      if (!stat.isFile()) throw new Error(`不是文件：${item}（相对项目目录 ${root}）`)
      copyOne(relative.split(path.sep).join('/'))
    }
  } else {
    walk('')
  }
  // 优先项目根目录的入口，其次任意同名文件，最后第一个 HTML。
  result.entry = exactEntry ?? fallbackEntry ?? htmlCandidate
  return result
}

/**
 * 开新任务前把上一轮任务的版本目录挪到 archive/，避免新任务从 v001 覆盖旧快照。
 * @param {string} taskDir - 会话任务目录。
 * @param {Record<string, any> | undefined} previous - 上一轮状态。
 * @returns {string | undefined} 归档目录；没有旧版本时 undefined。
 */
function archiveVersions(taskDir, previous) {
  const versionsDir = path.join(taskDir, 'versions')
  if (!fs.existsSync(versionsDir)) return undefined
  if (fs.readdirSync(versionsDir).length === 0) {
    // 空目录没有可归档的内容，别留下 0 文件的 archive。
    fs.rmSync(versionsDir, { recursive: true, force: true })
    return undefined
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const archiveDir = path.join(taskDir, 'archive', `${previous?.taskId ?? 'task'}-${stamp}`)
  fs.mkdirSync(path.dirname(archiveDir), { recursive: true })
  fs.renameSync(versionsDir, archiveDir)
  return archiveDir
}

/**
 * 生成模型/UI 共用的状态摘要。
 * @param {ReturnType<typeof normalizeConfig>} cfg - 插件配置。
 * @param {Record<string, any>} state - 状态。
 * @param {string | undefined} stateFile - 状态文件路径。
 * @returns {Record<string, any>} 摘要。
 */
function summarize(cfg, state, stateFile) {
  const now = Date.now()
  const remainingMs = state.deadline === null || state.deadline === undefined
    ? null
    : Math.max(0, Number(state.deadline) - now)
  const versions = Array.isArray(state.versions) ? state.versions : []
  const last = versions.length > 0 ? versions[versions.length - 1] : null
  return {
    taskId: state.taskId,
    phase: state.phase,
    objective: state.objective,
    plan: state.plan ?? '',
    cwd: state.cwd,
    stateFile: stateFile ?? null,
    createdAt: state.createdAt,
    deadline: state.deadline ?? null,
    budgetMs: state.budgetMs ?? null,
    remainingMs,
    remaining: formatDuration(remainingMs),
    versionCount: versions.length,
    lastVersion: last,
    versions: versions.map(item => ({
      version: item.version,
      label: item.label ?? null,
      summary: item.summary,
      createdAt: item.createdAt,
      files: item.files,
      bytes: item.bytes,
      entry: item.entry ?? null,
      truncated: item.truncated === true,
      path: item.path,
    })),
  }
}

/**
 * 装配四个工具定义。
 * @param {any} ctx - Host 上下文。
 * @param {ReturnType<typeof normalizeConfig>} cfg - 插件配置。
 * @returns {ReadonlyArray<Record<string, any>>} 工具定义。
 */
function buildTools(ctx, cfg) {
  const text = (value) => [{ type: 'text', text: value }]

  const requireActive = (agent) => {
    const loaded = loadForAgent(ctx, cfg, agent)
    if (loaded.state === undefined) {
      throw new Error('当前会话没有交付任务：先调用 ld_begin 建立任务与预算')
    }
    if (loaded.state.phase !== 'active') {
      throw new Error(`交付任务已结束（phase=${loaded.state.phase}）：需要继续请重新调用 ld_begin`)
    }
    return { ...loaded, state: loaded.state }
  }

  const ldBegin = {
    name: 'ld_begin',
    description: 'Start a live-delivery task: record the objective, plan, time budget, and state directory. Use it before the first version so every later version is retained and the budget is tracked.',
    parameters: {
      goal: { type: 'string', required: true, description: 'The user-facing objective, in one or two sentences.' },
      plan: { type: 'string', description: 'Optional. Omit unless the user asks for a written plan; never enumerate per-version contents.' },
      budget: { type: 'string', description: 'Total time budget such as 30m, 2h, or 1d. Omit to use the deployment default.' },
      dir: { type: 'string', description: 'Project directory holding the files to snapshot; relative paths resolve against the session working directory. Omit to use the session working directory. Task state is stored under the directory the session started in, so changing the working directory does not lose it.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => text(`交付任务已启动：#${String(value.taskId).slice(0, 8)}，预算 ${value.remaining}，状态文件 ${value.stateFile}。下一步：先交最小可用版本，自验后调用 ld_publish。`) },
    execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined || agent.session === undefined) {
        throw new Error('ld_begin 需要 agent 会话上下文')
      }
      const baseCwd = cwdOf(ctx, agent)
      const anchor = anchorCwdOf(ctx, agent.session)
      const projectDir = typeof args.dir === 'string' && args.dir.trim() !== ''
        ? path.resolve(baseCwd, args.dir)
        : baseCwd
      if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
        throw new Error(`项目目录不存在：${projectDir}`)
      }
      const loaded = loadForAgent(ctx, cfg, agent)
      if (loaded.state !== undefined && loaded.state.phase === 'active') {
        throw new Error(`本会话已有进行中的交付任务（${loaded.state.stateFile ?? loaded.stateFile}）：先 ld_done 结束，再开新任务`)
      }
      const taskDir = taskDirOf(cfg, anchor, agent.session.id)
      // 先校验预算，再归档：参数错误不应动到上一轮的快照。
      const budgetMs = parseBudget(args.budget ?? cfg.defaultBudget)
      const goal = String(args.goal ?? '').trim()
      if (goal === '') throw new Error('goal 不能为空：用一两句话写清要给用户的目标')
      // 磁盘上还有旧快照就先归档，即便 state.json 已损坏也不让新任务覆盖它们。
      archiveVersions(taskDir, loaded.state)
      const now = Date.now()
      const state = {
        taskId: randomUUID(),
        sessionId: String(agent.session.id),
        cwd: projectDir,
        baseCwd: anchor,
        objective: goal,
        plan: typeof args.plan === 'string' ? args.plan.trim() : '',
        createdAt: now,
        budgetMs: budgetMs ?? null,
        deadline: budgetMs === undefined || budgetMs === null ? null : now + budgetMs,
        phase: 'active',
        autoRounds: 0,
        totalAutoRounds: 0,
        lastAutoAt: 0,
        versions: [],
        endedAt: null,
        doneSummary: null,
      }
      // 状态始终落在会话工作目录，避免换了 dir 之后别的工具找不到任务。
      const stateFile = path.join(taskDir, 'state.json')
      writeStateFile(stateFile, state)
      return Promise.resolve(summarize(cfg, state, stateFile))
    },
    presentCall(args) {
      return { card: 'generic', title: `Start live delivery: ${String(args.goal ?? '').slice(0, 60)}`, kind: 'other' }
    },
  }

  const ldPublish = {
    name: 'ld_publish',
    description: 'Freeze the current working files as the next delivered version and record its summary. Call it only after the version actually works; the response states the remaining budget so you can plan the next version or wrap up.',
    parameters: {
      summary: { type: 'string', required: true, description: 'What changed and how you checked it. Do not restate the label or list later versions.' },
      label: { type: 'string', description: 'Short name of this version, for example "auto timer + pause". Do not repeat it in the summary.' },
      files: { type: 'array', items: { type: 'string' }, description: 'Files to include, relative to the project directory. Omit to snapshot the whole project directory under the snapshot limits.' },
      entry: { type: 'string', description: 'Entry file recorded for this version, relative to the project directory. Omit to use index.html when present.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const version = value.lastVersion
        const truncated = version?.truncated === true ? '快照已截断：超出文件数或字节上限。' : ''
        const spent = value.phase === 'active' && value.remainingMs !== null && value.remainingMs !== undefined && Number(value.remainingMs) <= 0
        const next = value.phase !== 'active'
          ? ''
          : spent
            ? '预算已用尽：不要再发布新版本，直接调用 ld_done 收尾。'
            : '继续下一版；目标达成或预算用尽时调用 ld_done。'
        return text(`已交付 v${version.version}：${version.files} 个文件、${Math.round(Number(version.bytes) / 1024)} KB${version.entry === null ? '' : `，入口 ${version.entry}`}。剩余预算 ${value.remaining}。${truncated}${next}`)
      },
    },
    execute(args, exec) {
      const { state, stateFile, cwd } = requireActive(exec.agent)
      const version = (Array.isArray(state.versions) ? state.versions.length : 0) + 1
      const versionsDir = path.join(path.dirname(stateFile), 'versions')
      const versionDir = path.join(versionsDir, `v${String(version).padStart(3, '0')}`)
      // 上一轮失败可能留下同名目录，先清掉再写，避免新版本混进旧文件。
      fs.rmSync(versionDir, { recursive: true, force: true })
      try {
        const snapshot = copySnapshot(state.cwd ?? cwd, versionDir, {
          files: args.files,
          ignore: cfg.snapshot.ignore,
          maxFiles: cfg.snapshot.maxFiles,
          maxBytes: cfg.snapshot.maxBytes,
          entry: typeof args.entry === 'string' && args.entry.trim() !== '' ? args.entry.trim() : cfg.snapshot.entry,
        })
        if (snapshot.files === 0) {
          throw new Error('没有可交付的文件：目录为空，或文件都被忽略规则排除（检查插件配置 snapshot.ignore，或用 files 显式列出文件）')
        }
        const rawLabel = typeof args.label === 'string' ? args.label.trim() : ''
        const record = {
          version,
          label: rawLabel === '' ? null : rawLabel,
          summary: args.summary,
          createdAt: Date.now(),
          files: snapshot.files,
          bytes: snapshot.bytes,
          entry: snapshot.entry,
          truncated: snapshot.truncated,
          path: versionDir,
        }
        state.versions = [...(Array.isArray(state.versions) ? state.versions : []), record]
        writeStateFile(stateFile, state)
        return Promise.resolve(summarize(cfg, state, stateFile))
      } catch (error) {
        // 失败不留下空版本目录。
        fs.rmSync(versionDir, { recursive: true, force: true })
        throw error
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Publish version: ${String(args.label ?? args.summary ?? '').slice(0, 60)}`, kind: 'other' }
    },
  }

  const ldStatus = {
    name: 'ld_status',
    description: 'Report this session\'s live-delivery task: phase, objective, budget remaining, delivered versions and their snapshot paths. Returns active: false when the session has no task.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (value.taskId === undefined) return text('当前会话没有交付任务。')
        const phaseWord = value.phase === 'active' ? '进行中' : value.phase === 'stopped' ? '已停止' : '已完成'
        const lines = [
          `任务：${phaseWord}`,
          `目标：${value.objective}`,
          `预算：${value.phase === 'active' ? `剩余 ${value.remaining}` : '已结束'}${value.budgetMs === null ? '' : `（共 ${formatDuration(value.budgetMs)}）`}`,
          `版本：${value.versionCount}`,
        ]
        for (const item of value.versions ?? []) {
          const label = item.label === null || item.label === undefined ? '' : ` ${item.label}`
          const truncated = item.truncated === true ? '（已截断）' : ''
          lines.push(`  v${item.version}${label} — ${item.files} 个文件 ${Math.round(Number(item.bytes) / 1024)} KB${truncated} ${item.path}`)
        }
        return text(lines.join('\n'))
      },
    },
    execute(_args, exec) {
      const loaded = loadForAgent(ctx, cfg, exec.agent)
      if (loaded.state === undefined) {
        return Promise.resolve({ active: false, cwd: loaded.cwd, stateFile: loaded.stateFile ?? null })
      }
      return Promise.resolve({ active: loaded.state.phase === 'active', ...summarize(cfg, loaded.state, loaded.stateFile) })
    },
  }

  const ldDone = {
    name: 'ld_done',
    description: 'Close the live-delivery task: mark it complete or stopped, keep every delivered version, and return the final summary. Call it when the objective is met or the budget is spent, before reporting the result.',
    parameters: {
      summary: { type: 'string', required: true, description: 'Final summary: what was delivered, and what remains open.' },
      outcome: { type: 'string', enum: ['complete', 'stopped'], description: 'complete when the objective is met; stopped when the budget ran out or the user stopped the task. Defaults to complete.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => text(`交付任务已结束（${value.phase}）：共 ${value.versionCount} 版，状态文件 ${value.stateFile}。`) },
    execute(args, exec) {
      const { state, stateFile } = requireActive(exec.agent)
      const outcome = args.outcome === 'stopped' ? 'stopped' : 'complete'
      state.phase = outcome
      state.endedAt = Date.now()
      state.doneSummary = args.summary
      writeStateFile(stateFile, state)
      return Promise.resolve(summarize(cfg, state, stateFile))
    },
  }

  return [ldBegin, ldPublish, ldStatus, ldDone]
}

/** live-delivery 技能正文：DSH 里由 skill 工具按名字加载。 */
const SKILL_CONTENT = `# Live delivery

长任务按版本交付：先交一个能用的最小版本，之后按真实结果一版一版推进。

## 流程

1. \`ld_begin\`：写目标与时间预算（如 30m / 2h）。plan 通常省略，不要写“v1 做什么、v2 做什么”这类清单。
2. 做最小可用版本：解决目标里最核心的一件事。
3. 自验：真的运行、打开或检查一遍。没验证过的版本不算交付。
4. \`ld_publish\`：label 写这版的短名（如“自动计时 + 暂停”）；summary 写改了什么、怎么验的。label 与 summary 不重复，也不要在 summary 里列举后续版本。
5. 按结果规划下一版：上一版暴露的问题优先，其次补功能。重复 2–5。
6. \`ld_done\`：目标达成用 complete，预算用尽或用户叫停用 stopped，并写清还有什么没做。

## 规则

- 每一版都要能独立使用；宁可小，不可半成品。
- 预算未尽且任务未完成时，不要宣布完成；预算用尽后不要再发布新版本，直接 ld_done 收尾。
- 不要为凑版本把同一份东西重复交付；没有实际变化就说明原因。
- 交付路径、剩余预算、版本号以工具返回为准，不要自己编。
- 用户中途提出新要求时，插入下一版，不推翻已交付版本。
- 插件可能在空闲后自动追加一轮继续推进，消息以 [live-delivery] 开头；按它的指示继续即可。
`

/** 自动续轮注入的提示词。 */
function buildContinuePrompt(state, round, remainingMs) {
  const last = Array.isArray(state.versions) && state.versions.length > 0
    ? state.versions[state.versions.length - 1]
    : null
  const lines = [
    `[live-delivery] 第 ${round} 轮自动续交付。`,
    `目标：${state.objective}`,
    last === null ? '当前还没有交付版本。' : `最近：v${last.version}${last.label === null || last.label === undefined ? '' : ` ${last.label}`}`,
    `剩余：${formatDuration(remainingMs)}`,
    '继续下一版，自验后 ld_publish；目标达成或预算用尽时 ld_done。',
  ]
  return lines.join('\n')
}

/** 提示词协议段落；没有进行中的任务时返回空串。 */
function renderPromptSection(ctx, cfg, context) {
  const session = context?.agent?.session
  if (session === undefined) return ''
  const loaded = loadForAgent(ctx, cfg, context.agent)
  const state = loaded.state
  if (state === undefined || state.phase !== 'active') return ''
  const remainingMs = state.deadline === null || state.deadline === undefined
    ? null
    : Math.max(0, Number(state.deadline) - Date.now())
  const versions = Array.isArray(state.versions) ? state.versions : []
  const last = versions.length > 0 ? versions[versions.length - 1] : null
  const lines = [
    '## Live delivery（插件 live-delivery 已接管本次任务的交付节奏）',
    `目标：${state.objective}`,
    `已交付：${versions.length} 版${last === null ? '' : `，最近 v${last.version} —— ${last.summary}`}`,
    `剩余预算：${formatDuration(remainingMs)}`,
  ]
  if (typeof state.plan === 'string' && state.plan.trim() !== '') lines.push(`计划：${state.plan}`)
  if (remainingMs !== null && remainingMs <= 0) {
    lines.push('预算已用尽：不要开新版本，直接调用 ld_done 收尾。')
  } else {
    lines.push('每版先自验再 ld_publish；预算未尽且任务未完成时不要结束；收尾调用 ld_done 后再汇报。')
  }
  return lines.join('\n')
}

/** 面板数据桥的路由；Client 半用 POST 读取任务摘要、等待变更。 */
const PANEL_ROUTE = '/api/live-delivery/query'

/** 每个会话上等待状态变更的长轮询；落盘时立刻唤醒。 */
const WATCHERS = new Map()

/**
 * 等待一个会话的下一次状态或开关变更。
 * @param {string} sessionId - 会话 id。
 * @param {AbortSignal | undefined} signal - 请求取消信号。
 * @returns {Promise<boolean>} 是否发生了变更；超时或取消返回 false。
 */
function waitForSessionChange(sessionId, signal) {
  return new Promise((resolve) => {
    let done = false
    let timer
    const settle = (changed) => {
      if (done) return
      done = true
      const set = WATCHERS.get(sessionId)
      if (set !== undefined) {
        set.delete(settle)
        if (set.size === 0) WATCHERS.delete(sessionId)
      }
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      resolve(changed)
    }
    const onAbort = () => settle(false)
    timer = setTimeout(() => settle(false), 20_000)
    signal?.addEventListener?.('abort', onAbort, { once: true })
    const set = WATCHERS.get(sessionId) ?? new Set()
    set.add(settle)
    WATCHERS.set(sessionId, set)
  })
}

/**
 * 唤醒一个会话上等待的长轮询。
 * @param {string} sessionId - 会话 id。
 * @returns {void}
 */
function notifySessionChange(sessionId) {
  const set = WATCHERS.get(String(sessionId))
  if (set === undefined) return
  for (const settle of [...set]) settle(true)
}

/**
 * 带 no-store 的 JSON 响应。
 * @param {unknown} value - 响应体。
 * @returns {Response} HTTP 响应。
 */
function replyJson(value) {
  return Response.json(value, { headers: { 'cache-control': 'no-store' } })
}

/**
 * 失败响应。
 * @param {string} code - 机器可读错误码。
 * @param {string} message - 人类可读说明。
 * @returns {Response} HTTP 响应。
 */
function replyFailure(code, message) {
  return replyJson({ ok: false, error: { code, message } })
}

/**
 * 解析会话的工作目录。
 * @param {any} ctx - Host 上下文。
 * @param {any} session - 会话。
 * @returns {string | undefined} 工作目录。
 */
function cwdOfSession(ctx, session) {
  if (session === undefined) return undefined
  try {
    return ctx.workingDirectory.get(session)
  } catch {
    return session.header?.cwd
  }
}

/**
 * 由会话 id 找到会话目录并返回其中的任务目录。
 * @param {any} ctx - Host 上下文。
 * @param {ReturnType<typeof normalizeConfig>} cfg - 插件配置。
 * @param {string} sessionId - 会话 id。
 * @returns {string | undefined} 任务目录。
 */
function stateDirForSession(ctx, cfg, sessionId) {
  const agent = ctx.get?.('agents')?.get?.(sessionId)
  const session = agent?.session ?? ctx.get?.('sessions')?.get?.(sessionId)
  if (session === undefined) return undefined
  const cwd = anchorCwdOf(ctx, session)
  return path.join(cwd, cfg.stateDir, String(sessionId))
}

/**
 * 会话开关文件的路径；开关存在会话目录，任务状态也在同一目录。
 * @param {ReturnType<typeof normalizeConfig>} cfg - 插件配置。
 * @param {string} cwd - 工作目录。
 * @param {string} sessionId - 会话 id。
 * @returns {string} 文件路径。
 */
function enabledPathOf(cfg, cwd, sessionId) {
  return path.join(cwd, cfg.stateDir, String(sessionId), 'enabled.json')
}

/**
 * 读取开关文件。
 * @param {string} file - 文件路径。
 * @returns {boolean} 是否开启。
 */
function readEnabledFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && parsed.enabled === true
  } catch {
    return false
  }
}

/**
 * 写入开关文件。
 * @param {string} file - 文件路径。
 * @param {boolean} enabled - 是否开启。
 * @returns {void}
 */
function writeEnabledFile(file, enabled) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({ enabled, since: Date.now() }, null, 2)}\n`, 'utf8')
  notifySessionChange(path.basename(path.dirname(file)))
}

/**
 * 读取某个会话的任务摘要与开关状态。
 * @param {any} ctx - Host 上下文。
 * @param {ReturnType<typeof normalizeConfig>} cfg - 插件配置。
 * @param {string} sessionId - 会话 id。
 * @returns {Response} JSON 响应。
 */
function handleStateQuery(ctx, cfg, sessionId) {
  const dir = stateDirForSession(ctx, cfg, sessionId)
  if (dir === undefined) return replyFailure('session-not-live', 'session is not live in this process')
  const stateFile = path.join(dir, 'state.json')
  const state = readStateFile(stateFile)
  const enabled = readEnabledFile(path.join(dir, 'enabled.json'))
  if (state === undefined) return replyJson({ ok: true, value: { enabled, summary: null, stateFile } })
  return replyJson({ ok: true, value: { enabled, summary: summarize(cfg, state, stateFile), stateFile } })
}

/**
 * 插件入口。
 * @param {any} ctx - Cordis 上下文。
 * @param {Record<string, unknown> | undefined} config - 行 config。
 * @returns {void}
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  warnUnknownConfig(ctx, config)

  // 开关是会话级的：默认关闭，只有用户 /deliver 打开后才暴露工具与提示词。
  const enabledCache = new Map()
  const skillDisposers = new Map()

  const enabledFor = (agent) => {
    const session = agent?.session
    if (session === undefined) return false
    const key = String(session.id)
    const cached = enabledCache.get(key)
    if (cached !== undefined) return cached
    const cwd = anchorCwdOf(ctx, session)
    const value = readEnabledFile(enabledPathOf(cfg, cwd, key))
    enabledCache.set(key, value)
    return value
  }

  const setEnabled = (agent, value) => {
    const session = agent?.session
    if (session === undefined) return
    const cwd = anchorCwdOf(ctx, session)
    if (typeof cwd !== 'string' || cwd === '') return
    const key = String(session.id)
    writeEnabledFile(enabledPathOf(cfg, cwd, key), value)
    enabledCache.set(key, value)
  }

  const ensureSkill = (agent) => {
    const session = agent?.session
    if (session === undefined) return
    const key = String(session.id)
    if (skillDisposers.has(key)) return
    // agent.ctx 是受限上下文：拿服务只能走 get()，直接取属性会抛 without inject。
    let skills
    try {
      const scope = agent.ctx
      skills = typeof scope?.get === 'function' ? scope.get('skills') : undefined
    } catch {
      skills = undefined
    }
    if (typeof skills?.register !== 'function') return
    try {
      const disposer = skills.register({
        name: 'live-delivery',
        description: 'Long-task progressive delivery: ship a usable first version, then improve version by version with a retained snapshot and a time budget.',
        whenToUse: 'Use after the user enables live delivery for this conversation and the task is long enough to review mid-way.',
        source: 'custom',
        content: SKILL_CONTENT,
      })
      skillDisposers.set(key, disposer)
    } catch (error) {
      ctx.logger?.warn?.(`live-delivery: could not register scoped skill: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const dropSkill = (agent) => {
    const key = String(agent?.session?.id ?? '')
    const disposer = skillDisposers.get(key)
    if (disposer === undefined) return
    skillDisposers.delete(key)
    try {
      disposer()
    } catch {
      /* 卸载期忽略 */
    }
  }

  const stopActiveTask = (agent) => {
    const loaded = loadForAgent(ctx, cfg, agent)
    if (loaded.state === undefined || loaded.state.phase !== 'active') return
    loaded.state.phase = 'stopped'
    loaded.state.endedAt = Date.now()
    loaded.state.doneSummary = loaded.state.doneSummary ?? '用户关闭了渐进交付'
    writeStateFile(loaded.stateFile, loaded.state)
  }

  for (const definition of buildTools(ctx, cfg)) {
    ctx.effect(() => ctx.tools.register(definition, { when: (activation) => enabledFor(activation.agent) }))
  }

  // 面板数据桥：Client 半用 POST 读取任务摘要。
  ctx.inject(['connection'], (c) => {
    const connection = c.get('connection')
    const register = connection?.fetch?.register
    if (typeof register !== 'function') return
    const registerRoute = register.bind(connection.fetch)
    c.effect(() => registerRoute({
      path: PANEL_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body
        try {
          body = await request.json()
        } catch {
          return replyFailure('bad-request', 'body is not JSON')
        }
        if (body === null || typeof body !== 'object' || typeof body.sessionId !== 'string' || body.sessionId === '') {
          return replyFailure('bad-request', 'sessionId is required')
        }
        const agent = ctx.get?.('agents')?.get?.(body.sessionId)
        if (agent === undefined) return replyFailure('session-not-live', 'session is not live in this process')
        try {
          if (body.method === 'watch') {
            const changed = await waitForSessionChange(body.sessionId, request.signal)
            return replyJson({ ok: true, value: { changed } })
          }
          return handleStateQuery(ctx, cfg, body.sessionId)
        } catch (error) {
          return replyFailure('internal', error instanceof Error ? error.message : String(error))
        }
      },
    }), 'live-delivery panel route')
  })

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'live-delivery',
    order: 480,
    interpolate: false,
    text: context => renderPromptSection(ctx, cfg, context),
  }))

  // 人的开关：/deliver 切换（on / off 可省略）。
  ctx.effect(() => ctx.commands.register({
    name: 'deliver',
    description: '切换渐进交付',
    input: { hint: 'on | off' },
    handler: (invocation) => {
      const agent = invocation.agent
      const raw = String(invocation.rawInput ?? '').trim().toLowerCase()
      const target = raw === 'off' || raw === 'stop'
        ? false
        : raw === 'on'
          ? true
          : !enabledFor(agent)
      setEnabled(agent, target)
      if (target) {
        ensureSkill(agent)
        return { kind: 'success', text: '渐进交付已开启。' }
      }
      dropSkill(agent)
      stopActiveTask(agent)
      return { kind: 'success', text: '渐进交付已关闭。' }
    },
  }))

  ctx.on('agent/created', ({ agent }) => {
    if (enabledFor(agent)) ensureSkill(agent)
  })
  // 插件重载（含 set_plugin 重载）后补回已开启会话的技能注册。
  for (const agent of ctx.get?.('agents')?.list?.() ?? []) {
    if (enabledFor(agent)) ensureSkill(agent)
  }
  ctx.on('agent/disposed', ({ agent }) => {
    dropSkill(agent)
    enabledCache.delete(String(agent?.session?.id ?? ''))
  })

  // 插件卸载时收回 scoped 技能注册，并释放所有等待中的长轮询。
  ctx.effect(() => () => {
    for (const set of [...WATCHERS.values()]) {
      for (const settle of [...set]) settle(false)
    }
    WATCHERS.clear()
    for (const disposer of skillDisposers.values()) {
      try {
        disposer()
      } catch {
        /* 忽略 */
      }
    }
    skillDisposers.clear()
    enabledCache.clear()
  })

  // 自动续轮：仅开启时、且已有至少一版、预算还够、未达上限。
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle' || cfg.autoContinue !== true) return
    if (!enabledFor(agent)) return
    try {
      const loaded = loadForAgent(ctx, cfg, agent)
      const state = loaded.state
      if (state === undefined || state.phase !== 'active') return
      if (!Array.isArray(state.versions) || state.versions.length === 0) return
      const roundsStarted = Number(state.totalAutoRounds ?? state.autoRounds ?? 0)
      if (roundsStarted >= cfg.maxAutoRounds) return
      const remainingMs = state.deadline === null || state.deadline === undefined
        ? Infinity
        : Number(state.deadline) - Date.now()
      if (remainingMs <= 60_000) return
      const now = Date.now()
      if (now - Number(state.lastAutoAt ?? 0) < 1500) return
      const round = roundsStarted + 1
      const next = { ...state, totalAutoRounds: round, lastAutoAt: now }
      writeStateFile(loaded.stateFile, next)
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: buildContinuePrompt(next, round, remainingMs) }],
        source: { kind: 'live-delivery', form: 'notice', summary: `Live delivery round ${round}` },
      })
    } catch (error) {
      // 续轮失败就永久关闭本进程的自动续轮，避免每次空闲都重试。
      cfg.autoContinue = false
      ctx.logger?.warn?.(`live-delivery: auto-continue disabled after error: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

