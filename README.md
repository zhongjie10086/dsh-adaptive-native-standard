# Adaptive Native Standard

面向 Windows 原生 DeepSeek Harness（DSH）的社区 Agent Preset。它以官方 Standard 的完整能力为底座，首请求仅锚定 Minimal persona，之后启用任务自适应路由、按需工具发现和紧凑的 Git Bash 执行器。

当前版本：`0.1.0`

> 本项目不是 DeepSeek 官方项目，也不受 DeepSeek 官方背书。

## 适合谁

- 在 Windows 10/11 上原生运行 DSH；
- 希望日常文件操作优先使用 `pwsh + read + write + edit + glob + grep`；
- 需要 POSIX 命令时，希望模型可以自行发现并解锁 Git for Windows；
- 希望保留 Standard 的 Web、subagent、workflow、goal、后台任务等能力，但不想把完整工具目录长期塞进每轮请求。

## 核心能力

- **Standard 能力底座**：保留官方 Standard 的上下文、技能、subagent、workflow、goal 和 jobs 体系。
- **首请求 persona 锚定**：只替换首请求的 deployment persona，不复制 Minimal 的工具限制或删除 Standard 上下文。
- **Windows 原生常驻工具**：首轮、晋升后和 compaction 恢复期均保留 `pwsh/read/write/edit/glob/grep`。
- **自适应路由**：按任务选择 `spec`、`react` 或 `weak`，支持自动模式和手动锁定。
- **we-need 推理风格**：作为可关闭的私有推理引导，不要求输出 `<think>` 标签，也不改变最终回复语言。
- **按需能力解锁**：通过 `dev_tool_search` 解锁 Git Bash、旧编辑器、Web、subagent、workflow、goal、jobs 等工具。
- **Direct Bash**：自动探测 Git for Windows，处理 Windows/MSYS 路径、相对工作目录、超时、取消、进程树终止、长输出截断和完整输出 spill。
- **清晰的命令结果**：stdout/stderr 分开呈现，非零退出作为普通命令结果返回，并明确标记 `[exit code: N]`。
- **会话隔离**：为 Bash 注入安全的 `DSH_HOME / DSH_SHELL / DSH_SESSION_ID / DSH_WEB_URL` 子集；默认不暴露 `DSH_SESSION_JSONL`。

## 要求

- Windows 10/11；
- DeepSeek Harness `0.1.0-rc.5`；
- Git for Windows；
- DSH 已配置可用的模型 Provider。推荐在 DeepSeek V4 Pro 上使用高推理强度，但 Preset 本身不绑定 API 密钥或 Provider。

DSH 更新可能改变 Cordis composition、工具 schema 或服务边界。升级 DSH 后请先运行兼容检查，再覆盖现有安装。

## 安装

下载或克隆本仓库后，在 PowerShell 中运行：

```powershell
Set-Location <仓库目录>
.\scripts\install.ps1
```

如果已经安装旧版本：

```powershell
.\scripts\install.ps1 -Update
```

脚本会安装到：

```text
%USERPROFILE%\.dsh\.agent-presets\adaptive-native-standard
```

更新时，旧目录会先移动到 `%USERPROFILE%\.dsh\.preset-backups\`，不会直接覆盖。安装完成后重启：

```powershell
Set-Location C:\Dev\deepseek-harness
pnpm dsh web
```

新建会话并选择 **Adaptive Native Standard**。不要在已有内容的会话中途切换 Preset。

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

长驻开发服务器、watcher 和长测试应使用官方 `pwsh` 的 `run_in_background`，再按需解锁 `job_list / job_output / job_kill`。`subagent` 与 `subagent_fork` 使用 continuable 后台模式。Direct Bash 故意不提供后台参数，避免用裸 `&` 制造孤儿进程。

## 安全边界

Direct Bash **没有 Windows OS 沙箱，也没有逐命令审批**。一旦模型解锁 `bash`，命令将以 DSH 服务进程当前的 Windows 用户权限运行。

- 只在可信工作区使用；
- 建议把会话权限明确设置为 `danger-full-access`，让界面显示与实际 Bash 权限一致；
- 如果任务需要严格隔离或逐命令审批，请不要使用本 Preset；
- 不要把 API 密钥写进仓库、Preset 配置或提示词。

## 配置

主要配置位于 `preset/agent.cordis.yml`：

| 配置 | 默认值 | 作用 |
|---|---|---|
| `defaultMode` | `auto` | `auto / spec / react / weak` |
| `reasoningStyle` | `we-need` | 可改为 `native` 关闭风格引导 |
| `nearFieldGuidance` | `true` | 在后续真实用户消息附近补充短引导 |
| `maxFaults` | `3` | 路由层连续故障熔断阈值 |
| `managedSessionEnv` | `true` | 向 Direct Bash 注入安全 DSH 会话变量子集 |
| `includeSessionJsonl` | `false` | 是否额外暴露当前会话 JSONL 路径 |

一般不建议启用 `includeSessionJsonl`。它可能暴露本地对话工件位置，而且落盘内容可能滞后于当前轮次。

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
