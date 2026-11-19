# @0rch1d/dsh-live-delivery

Qwen-Live-Delivery-Plugin 的 DeepSeek Harness 原生适配：让长任务先交一个能用的版本，之后按版本迭代，预算与快照都留在工作目录里。

**默认不启用。** 在对话里输入 `/deliver` 打开，再输入一次关闭。

## 安装

发布版：

```text
plugin_manager action=install_bundle target=@0rch1d/dsh-live-delivery
```

从本工作区目录安装（开发时）：

```text
plugin_manager action=install_bundle target=D:\Tool\dsh\packages\dsh-live-delivery
```

行 id 为 `live-delivery`，可在 Plugins 页停用/启用。

## 提供什么

- 命令：`/deliver`（`on` / `off` 可省略）
- 工具：`ld_begin` / `ld_publish` / `ld_status` / `ld_done`
- 技能：`live-delivery`
- 自动续轮：空闲且预算未尽时追加一轮
- 快照：`<会话创建目录>/.live-delivery/<sessionId>/versions/vNNN/`
- 面板：输入区药丸 + 摘要浮层
- 数据桥：`POST /api/live-delivery/query`

状态与开关都锚在 `<会话创建目录>/.live-delivery/<sessionId>/`，中途 `cd` 不会丢任务。同一会话开新任务时，上一轮快照移到 `archive/`。

## 面板

输入框下方的药丸显示当前版本与剩余预算；点开是挂在 `body` 上的浮层，列出各版标签、相对时间与截断标记。数据由长轮询获取：状态落盘立即唤醒（20 秒超时），另有 30 秒兜底刷新；药丸收起时也保持订阅。

## 配置

profile 的 `cordis.patch.yml` 里给 `live-delivery` 行写 `config`：

```yaml
- id: live-delivery
  config:
    autoContinue: false   # 关掉自动续轮（开启状态下才有意义）
    maxAutoRounds: 3      # 每任务累计自动续轮上限
    defaultBudget: 20m
    snapshot:
      maxFiles: 800
      maxBytes: 33554432  # 32 MiB
      ignore:             # 追加到默认忽略列表之后
        - 'generated/**'
        - '*.tmp'
```

`snapshot.ignore` 在默认列表（`node_modules`、`.git`、`.next`、缓存目录等）之外追加规则：不含 `/` 的按名字匹配，含 `/` 的按相对路径 glob 匹配（`*` 不跨目录，`**` 跨目录）。构建产物目录默认保留；不想交付就自己加进 ignore。

## 限制

- 快照有文件数与字节上限；超出时 `ld_publish` 的回执会明确写“快照已截断”，`ld_status` 里也有标记。
- 预算不是硬性拦截：用尽后仍可发布，但 `ld_publish` 回执会改为“预算已用尽，直接 `ld_done` 收尾”，自动续轮也会停。
- 发布失败（缺文件、空目录）不会留下空版本目录；`ld_begin` 参数非法时也不会先归档旧快照。
- 同一会话开新任务时，上一轮的 `versions/` 会整体移到 `archive/<taskId>-<时间>/`，新旧快照不会互相覆盖。
- 自动续轮只在开启、已至少交付一版、剩余预算 > 60s、未达任务累计上限时触发；发布新版本不会重置累计轮数。失败一次就永久关闭。
- 状态与开关都锚在**会话创建目录**的 `.live-delivery/`，中途 `cd` 到别处不会丢任务；它们不是会话事件，删除该目录等于放弃版本记录与开关。
- 关闭开关只结束任务、隐藏工具，不删除已交付快照。
- 开关是会话级的：子会话不继承，只有被 `/deliver` 打开的那个会话能用这些工具。

## 测试

```powershell
npm test    # state / panel / client 三套
```

`tests/client.spec.mjs` 用假 `require`、`document` 与 slots 驱动 `client.js`，校验槽位注册项、`inject` 注入的会话 id 和样式清理；`npm test` 在发布前跑全部三套。

工具定义形状用运行中的真实 `dsh-tools` 校验（必须用 DSH 的 Electron 运行时读 `app.asar`）：

```powershell
$start = [System.Diagnostics.ProcessStartInfo]::new($env:DSH_NODE_EXECUTABLE)
$start.ArgumentList.Add('D:\Tool\dsh\packages\dsh-live-delivery\tests\runtime-shape.mjs')
$start.Environment['ELECTRON_RUN_AS_NODE'] = '1'
$start.UseShellExecute = $false
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
[System.Diagnostics.Process]::Start($start).WaitForExit()
```

## 发布

包是 `type: module`、零运行时依赖、无构建步骤，`npm publish` 直接发；`files` 里只列运行时需要的文件。`engines.dsh` 声明最低 DSH 版本。

```powershell
npm pack --dry-run   # 先核对打包清单
npm publish
```

## 与原插件的差异

| 原插件（Codex CLI） | 本适配（DSH） |
| --- | --- |
| MCP server 提供四个工具 | `ctx.tools` 注册四个 Host 工具，按会话开关决定是否暴露 |
| Stop hook 阻止提前收尾 | 会话空闲后自动续轮（可关） |
| 本地浏览器工作台（含产物预览） | 输入区浮层：摘要与版本演进；产物直接看工作目录 |
| 安装脚本改 Codex 配置 | 标准 DSH bundle，Plugins 页安装 |

详细说明见 [docs/DETAIL.md](docs/DETAIL.md)。
