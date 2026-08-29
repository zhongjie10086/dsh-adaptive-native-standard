# Adaptive Native for Windows

面向 Windows 原生 DeepSeek Harness（DSH）的社区 Agent Preset bundle。一次安装提供两个明确选项：**Adaptive Native Standard** 保留 Standard 上下文底座；**Adaptive Native Minimal** 的首个模型请求采用 Minimal 结构，仅暴露 `read + dev_tool_search`，随后持久提升、恢复 Windows 核心工具并按需发现重型能力。两者都使用自适应任务路由和紧凑的 Git Bash 执行器。

当前版本：`0.2.2`

> 本项目不是 DeepSeek 官方项目，也不受 DeepSeek 官方背书。

## 适合谁

- 在 Windows 10/11 上原生运行 DSH；
- 希望日常文件操作优先使用 `pwsh + read + write + edit + glob + grep`；
- 希望在完整 Standard 与真正 Minimal-first 的首请求之间明确选择；
- 需要 POSIX 命令时，希望模型可以自行发现并解锁 Git for Windows；
- 希望保留 Standard 的 Web、subagent、workflow、goal、后台任务等能力，但不想把完整工具目录长期塞进每轮请求。

## 两个预设

| 预设 | 首个模型请求 | 提升后 | 适合场景 |
|---|---|---|---|
| **Adaptive Native Standard** | Standard 上下文；`pwsh/read/write/edit/glob/grep` | 保留六个工作工具并加入按需发现 | 日常仓库开发、长任务、多子代理 |
| **Adaptive Native Minimal** | 基础 persona + 分类命中的一套 Adaptive task persona；Weak 任务可附一条 near-field；无运行时/项目/Skills 注入；仅 `read/dev_tool_search` | 恢复运行时与固定工具规范，保持原生推理，自动提供 Windows 核心工具 | 短任务、低提示干扰、受控探索 |

Minimal 的“首轮”指首个 **LLM request**，不是整个用户回合。首次持久 `tool/call` 或 `assistant/message` 后，同一用户回合内的下一次模型请求就会进入提升状态。提升从会话事件重建，跨 compaction、会话恢复、DSH 重载和 Controller 重启保持，不会回退到 bootstrap。

Minimal 的 `Spec / React / Weak` 路由由会话的首条真实用户消息确定，后续用户轮次不会重新分类整个会话；Weak 的近场指导仍只贴近当前轮任务。`dev_tool_search` 的能力索引把 Git Bash 放在末项，只有确实需要 POSIX / Git Bash 语义时才按需解锁。

Minimal 提升后不会一次暴露 Standard 全目录。`pwsh/read/write/edit/glob/grep` 与 `dev_tool_search` 自动可用；Skills、Web、subagent、workflow、goal、jobs 和 Git Bash 仍通过 `dev_tool_search` 按需解锁。首次提升时仅注入一个项目指令文件位置提示，模型在修改前使用 `read` 读取适用的 `AGENTS.md` / `CLAUDE.md`；不自动注入全文或完整 Skills 目录。

Minimal 的顶层会话严格经历一次 bootstrap；新建 subagent 默认直接处于提升状态，避免子代理在收到已分派任务后还要额外消耗一次模型请求来解锁能力。

## 核心能力

- **双上下文底座**：Standard 保留官方 Standard 的上下文体系；Minimal 保持自己的短 persona，并在提升后只恢复必要运行时上下文。
- **Minimal-first 独立选项**：首请求只有基础 persona、分类命中的一套 Adaptive task persona、用户消息与 `read/dev_tool_search` 两个 schema；Weak 任务可附一条 near-field，不使用 `str_replace_editor`。
- **Standard 首请求锚定**：Standard 只替换首请求的 deployment persona，不复制 Minimal 的工具限制或删除 Standard 上下文。
- **Windows 原生工具面**：Standard 常驻 `pwsh/read/write/edit/glob/grep`；Minimal 首请求仅有 `read/dev_tool_search`，提升后自动恢复 `pwsh/read/write/edit/glob/grep/dev_tool_search`。
- **自适应路由**：按任务选择 `spec`、`react` 或 `weak`，支持自动模式和手动锁定。
- **分预设推理风格**：Standard 保留 we-need 私有推理引导；Minimal 使用原生推理，但保留 Adaptive task persona 与 Weak task near-field 指导。
- **按需能力解锁**：通过 `dev_tool_search` 解锁 Git Bash、旧编辑器、Web、subagent、workflow、goal、jobs 等工具。
- **Direct Bash**：自动探测 Git for Windows，跳过 `System32 / Sysnative / SysWOW64` 中的 WSL 启动器，并处理 Windows/MSYS 路径、相对工作目录、超时、取消、进程树终止、长输出截断和完整输出 spill；找不到 Git Bash 时会给出明确错误，不会回退到含义不确定的裸 `bash`。
- **清晰的命令结果**：stdout/stderr 分开呈现，非零退出作为普通命令结果返回，并明确标记 `[exit code: N]`。
- **会话隔离**：为 Bash 注入安全的 `DSH_HOME / DSH_SHELL / DSH_SESSION_ID / DSH_WEB_URL` 子集；默认不暴露 `DSH_SESSION_JSONL`。

## 要求

- Windows 10/11；
- DeepSeek Harness `0.1.2-alpha.1`（锁定提交 `cd5ef814`）；
- Git for Windows；
- DSH 已配置可用的模型 Provider。推荐在 DeepSeek V4 Pro 上使用高推理强度，但 Preset 本身不绑定 API 密钥或 Provider。

DSH 更新可能改变 Cordis composition、工具 schema 或服务边界。升级 DSH 后请先运行兼容检查，再覆盖现有安装。

## 隐私与公开仓库边界

公开仓库只包含运行所需源码、预设、安装脚本、说明和功能性单元测试。以下内容仅保留在本地，不随 Git 上传：私有评测题目与计划、原始会话和思维链、逐运行 JSON/JSONL、行为审计、成本与质量报告、API 配置、浏览器 profile、日志以及生成产物。

`.gitignore` 已覆盖 `.artifacts/`、`.generated/`、`eval/`、`evaluation/`、`docs/plans/`、私有文档目录、Session 压缩日志和常见密钥格式。发布前仍应检查 `git status` 与已暂存差异；忽略规则不会阻止已经被 Git 跟踪的文件，也无法识别误写进普通源码或 README 的秘密值。

## 安装（推荐：DSH bundle）

从 DeepSeek Harness 源码 checkout 运行时：

```powershell
Set-Location C:\Dev\deepseek-harness
pnpm dsh plugin --profile web add github:zhongjie10086/dsh-adaptive-native-standard
pnpm dsh web
```

如果使用已经安装到 PATH 的 `dsh` CLI：

```powershell
dsh plugin --profile web add github:zhongjie10086/dsh-adaptive-native-standard
dsh web
```

如果使用 DSH Desktop，请从托盘打开 **Open DSH Terminal**，安装到 Desktop 当前使用的 profile：

```powershell
dsh plugin --profile desktop add github:zhongjie10086/dsh-adaptive-native-standard
```

bundle 首次随 profile 启动时，会部署两个自包含 Agent Preset：

```text
%USERPROFILE%\.dsh\.agent-presets\adaptive-native-standard
%USERPROFILE%\.dsh\.agent-presets\adaptive-native-minimal
```

已有手动安装与随包内容完全相同时，bundle 会安全接管并写入所有权标记；内容不同则保留原目录并给出警告，不会覆盖。bundle 管理的旧版本在更新前会移入 `%USERPROFILE%\.dsh\.preset-backups\`。

重启后新建会话并选择 **Adaptive Native Standard** 或 **Adaptive Native Minimal**。不要在已有内容的会话中途切换 Preset。

移除 profile 中的 bundle：

```powershell
Set-Location C:\Dev\deepseek-harness
pnpm dsh plugin --profile web remove dsh-adaptive-native-standard
```

DSH 当前没有 package-owned preset-root 的卸载钩子，因此移除 bundle 不会自动删除已经部署的 preset；如需同时移除，请继续使用本仓库的 `scripts/uninstall.ps1`，或在 Agent Presets 设置中删除对应目录。

## 手动安装（备用）

下载或克隆本仓库后，在 PowerShell 中运行：

```powershell
Set-Location <仓库目录>
.\scripts\install.ps1
```

如果已经安装旧版本：

```powershell
.\scripts\install.ps1 -Update
```

脚本会同时安装到：

```text
%USERPROFILE%\.dsh\.agent-presets\adaptive-native-standard
%USERPROFILE%\.dsh\.agent-presets\adaptive-native-minimal
```

更新时，旧目录会先移动到 `%USERPROFILE%\.dsh\.preset-backups\`，不会直接覆盖。安装完成后重启：

```powershell
Set-Location C:\Dev\deepseek-harness
pnpm dsh web
```

新建会话并选择两个 Adaptive Native 预设之一。不要在已有内容的会话中途切换 Preset。

卸载采用可恢复移动：

```powershell
.\scripts\uninstall.ps1
```

## 使用方式

普通 Windows 编码直接让模型工作即可。需要 POSIX shell 时，模型可以调用：

```json
{"toolNames":["bash"]}
```

这是 `dev_tool_search` 的参数；解锁后的下一次请求会出现 `bash`。模型可以自主执行这个流程，不需要用户手工输入 JSON。

Minimal 模式第一次通常先调用 `read` 检查，或调用 `dev_tool_search` 发现所需能力。第一次持久操作后会自动获得 `pwsh/write/edit/glob/grep`；修改已有文件的推荐路径是先完成官方 `read` 观察，再直接调用 `edit`。这样符合 DSH 的 read-before-edit 策略，也避开 `str_replace_editor` 的绝对路径和替换状态约束。

长驻开发服务器、watcher 和长测试应使用官方 `pwsh` 的 `run_in_background`，再按需解锁 `job_list / job_output / job_kill`。`subagent` 与 `subagent_fork` 使用 continuable 后台模式。Direct Bash 故意不提供后台参数，避免用裸 `&` 制造孤儿进程。

## 安全边界

Direct Bash **没有 Windows OS 沙箱，也没有逐命令审批**。一旦模型解锁 `bash`，命令将以 DSH 服务进程当前的 Windows 用户权限运行。

- 只在可信工作区使用；
- 建议把会话权限明确设置为 `danger-full-access`，让界面显示与实际 Bash 权限一致；
- 如果任务需要严格隔离或逐命令审批，请不要使用本 Preset；
- 不要把 API 密钥写进仓库、Preset 配置或提示词。

## 配置

Standard 的源配置位于 `preset/agent.cordis.yml`。Minimal 配置由 `scripts/generate-minimal-preset.mjs` 从同一能力底座确定性生成到 `preset-minimal/agent.cordis.yml`，避免两个大 composition 手工漂移：

| 配置 | 默认值 | 作用 |
|---|---|---|
| `defaultMode` | `auto` | `auto / spec / react / weak` |
| Standard `reasoningStyle` | `we-need` | Standard 的私有推理风格引导 |
| Minimal `reasoningStyle` | `native` | 不注入 we-need 正文或 near-field 风格提醒 |
| `nearFieldGuidance` | `true` | 从首请求开始，为 Weak 任务在用户消息附近补充一条短引导；复杂任务额外关注架构、边界与集成点 |
| `maxFaults` | `3` | 路由层连续故障熔断阈值 |
| `managedSessionEnv` | `true` | 向 Direct Bash 注入安全 DSH 会话变量子集 |
| `includeSessionJsonl` | `false` | 是否额外暴露当前会话 JSONL 路径 |
| Minimal `bootstrapTools` | `read, dev_tool_search` | 首个模型请求的唯一两个工具 |
| Minimal `residentTools` | `pwsh, write, edit, glob, grep, dev_tool_search` | 与 bootstrap 合并后形成提升态 Windows 核心工具面 |
| Minimal `resetOnCompaction` | `false` | 提升状态跨压缩和恢复保持 |
| 统一搜索设置中的 `fetchEnabled` | `false` | 决定 DSH 下次启动时是否为 Adaptive 注册原生 `web_fetch` |

一般不建议启用 `includeSessionJsonl`。它可能暴露本地对话工件位置，而且落盘内容可能滞后于当前轮次。

安装 DSH Unified Search 后，可在其设置页直接开启或关闭 Fetch。DSH rc.8 在进程启动时挂载 Preset，所以改动后需重启 DSH。这个开关只决定本 Preset 是否注册 DSH 已有的 `web_fetch` schema 与指引，不会增加第三个模型工具；正文 Provider、安全代理和 SSRF 边界仍由搜索插件负责。未安装统一搜索插件时保持关闭。

## 验证

```powershell
npm run check
npm run verify:dsh -- C:\Dev\deepseek-harness
```

公开仓库包含功能单元测试和 composition 静态校验。开发阶段另有多轮行为评测，但为避免测试泄漏，benchmark 题目、隐藏断言、原始会话、费用/耗时记录和详细数据报告不随仓库发布。README 只提供设计级描述，不宣称通用能力分数。

## 设计来源与致谢

本项目组合并改编了以下 MIT 许可项目的思想或代码，并在 [NOTICE](NOTICE) 中保留详细归属：

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：Standard composition 与运行时接口；
- [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)：两阶段锚定、晋升和 compaction 恢复；
- [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite) 的 router-standard / mode-boost：任务分带、persona 和近场路由；
- [oh-we-need](https://github.com/scp3500/oh-we-need)：DeepSeek V4 推理风格；
- [opencode-routing-suite](https://github.com/cuddly-guacamole/opencode-routing-suite)：稳定 band、手动模式与 fail-open 思路；
- [dsh-gitbash-preset](https://github.com/liceses/dsh-gitbash-preset)：Git for Windows 自动发现与路径兼容思路。

开发时还阅读了 [myDshPresets](https://github.com/0liveiraaa/myDshPresets) 和 [v4-flash-godmode-opencode-go](https://github.com/SheberDavid/v4-flash-godmode-opencode-go) 作为社区设计参考；本仓库不复制它们的源码，也不对其未明确覆盖的内容作许可证推定。公开可读的 GitHub 仓库并不自动等于开源许可。

## 许可证

MIT。参见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
