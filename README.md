# @0rch1d/dsh-live-delivery

DeepSeek Harness 渐进交付插件。适用于长耗时任务：Agent 先交付可用的基础版本，再按版本号持续迭代；预算状态与文件快照均保存在工作目录中。

## 安装与启用

```text
dsh plugin --profile <profile> add @0rch1d/dsh-live-delivery
```

默认关闭。在对话中输入 `/deliver` 启用，再次输入关闭。开关按会话独立保存，子会话不继承。

## 功能与工作机制

* **交互入口**
  * 命令 `/deliver [on|off]`：切换当前会话的渐进交付状态。
  * 输入框状态徽标：显示当前版本号与剩余预算；点击展开详情浮层，查看各版本标签、时间与截断状态（数据经长轮询同步，20 秒超时，另有 30 秒保底轮询）。

* **工具与技能**
  * 启用后注册 `live-delivery` 技能与四个工具：`ld_begin`、`ld_publish`、`ld_status`、`ld_done`。
  * 工具引导模型按“最小可用版本 → 自验 → 发布快照 → 迭代”的流程执行。

* **快照与归档**
  * 状态与快照保存在**会话创建目录**下的 `.live-delivery/<sessionId>/`；中途切换工作目录不影响任务追踪。
  * 每次调用 `ld_publish` 将项目文件快照保存至 `versions/vNNN/`。
  * 同一会话开启新任务时，上一轮的 `versions/` 归档至 `archive/<taskId>-<时间>/`。
  * 关闭 `/deliver` 仅结束当前任务并隐藏工具，已交付快照保留。

* **自动续轮**
  * 触发条件：任务进行中、已至少发布一个版本、剩余预算大于 60 秒、未达轮次上限。
  * 会话进入空闲状态时自动追加下一轮执行；若发生错误，自动续轮在当前进程内关闭。

* **预算机制**
  * 预算（如 `30m`、`2h`）为软性约束，用于提醒模型控制执行范围。
  * 预算用尽后仍可发布版本，但工具返回值会提示结束任务，并停止自动续轮。

## 配置

修改配置会触发插件重载，因此配置项需通过用户 profile 的 `cordis.patch.yml` 覆盖，不会出现在 Settings 页面。

在用户 profile 的 `cordis.patch.yml` 中按 `id: live-delivery` 覆盖 `config`：

```yaml
- id: live-delivery
  name: "@0rch1d/dsh-live-delivery"
  config:
    autoContinue: false   # 是否开启空闲自动续轮（默认 true）
    maxAutoRounds: 3      # 单任务最大自动续轮次数（默认 6）
    defaultBudget: 20m    # ld_begin 未指定预算时的默认值（默认 30m）
    stateDir: .live-delivery
    snapshot:
      maxFiles: 800       # 单次快照最大文件数（默认 1500）
      maxBytes: 33554432  # 单次快照最大字节数，32 MiB（默认 64 MiB）
      entry: index.html   # 默认入口文件
      ignore:             # 追加到默认忽略列表之后
        - 'generated/**'
        - '*.tmp'
```

* **全量覆盖**：`config` 节点为整行替换，未声明的字段使用插件默认值。
* **忽略规则**：`snapshot.ignore` 在默认列表（`node_modules`、`.git`、`.next` 等缓存与版本控制目录）之外追加过滤。不含 `/` 的规则按文件名或目录名匹配，含 `/` 的按相对路径 glob 匹配（`*` 不跨目录，`**` 跨目录）。构建产物目录默认保留。

查看生效的完整配置：

```powershell
dsh --profile "$env:DSH_PROFILE" --dump-config
```

## 与原版插件的差异

| 特性 | 原版（Codex CLI） | 本适配（DeepSeek Harness） |
| --- | --- | --- |
| 工具注册 | 独立 MCP Server 提供 | Host 原生工具（`ctx.tools`），按会话开关动态暴露 |
| 续轮控制 | Stop Hook 拦截退出 | 监听 `agent/status` 空闲事件自动追加对话轮次 |
| 界面交互 | 本地浏览器工作台与产物预览 | 输入区状态徽标与版本浮层，产物直接查看工作目录 |
| 安装配置 | 脚本修改 Codex 配置文件 | 标准 DSH Bundle，支持 Plugins 页面管理 |

## 开发与测试

运行单元测试（覆盖状态管理、UI 面板与客户端注入）：

```powershell
npm test
```

使用 DSH 内置的 Electron Node 运行时校验工具 Schema 形状：

```powershell
$start = [System.Diagnostics.ProcessStartInfo]::new($env:DSH_NODE_EXECUTABLE)
$start.ArgumentList.Add('D:\Tool\dsh\packages\dsh-live-delivery\tests\runtime-shape.mjs')
$start.Environment['ELECTRON_RUN_AS_NODE'] = '1'
$start.UseShellExecute = $false
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
[System.Diagnostics.Process]::Start($start).WaitForExit()
```

详细界面预览见 [docs/DETAIL.md](docs/DETAIL.md)。
