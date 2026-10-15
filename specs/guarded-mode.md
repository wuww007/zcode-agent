# Guarded 协作模式

移植自官方 v3.15.1（`docs/dangerous-command-approval-v1-plan.md`）。本地在 v3.14.3 基线上按功能摘取，审批链内联回单文件 `permission-flow.ts`，不引入官方的 executor 拆分重构。

## 产品规则

1. `guarded` 是第五种协作模式（`plan | build | edit | yolo | guarded | auto`），显式选择启用，不改默认值，不迁移已有任务/自动化/配置。
2. 语义：**YOLO 基础策略 + 明确危险命令的用户单次批准（user-once）**。未命中危险规则的命令按 YOLO 照常执行；命中后走既有审批链路（matcher → Bash ToolEntry.userApprovalRule → PermissionService → executor/broker → 单次批准/拒绝 → 原 tool result）。
3. Plan 优先于 guarded：`guarded + planEnabled=true` 仍受 Plan 判权约束；进入/退出 Plan 保留 guarded 权限。
4. 危险请求的 user-once 约束优先：不提供也不接受项目/会话永久授权或 Full access，不被 `prepareApproval.proceed` 放行；Hook allow 不代批。
5. 子任务继承分三类：
   - **Agent 工具子代理**（Explore/general-purpose/custom）经 `inheritPermissionMode`：父 guarded 且子解析为 yolo（含 builtInExplore）时保持 guarded；显式 plan/auto 保留各自策略。
   - **dynamic-workflow run 内 actor** 跑在**建 run 那一刻**会话的权限模式上（journal `run-launched.subagentPermissionMode`，plan 记为 build、缺席即 YOLO）：guarded 会话发起的 run，其 actor 的危险命令同样走 user-once，经父 broker 请求且 origin 标注子代理；会话此后换模式不影响在飞 run。
   - **legacy workflow child**（expert/script）不在 guarded 合同内，保持 YOLO；workflow 启动也不得把父会话的 guarded 降级为 yolo。
6. UI 名称"自主模式 / Autonomous mode"，描述"在有风险时询问 / Ask when there's risk"；沿用浅蓝 `icon-blue` 与 Edit 的 `ShieldCheckIcon`；内部 mode 值、CLI 命令、默认值与保存恢复不变。guarded 只替换菜单中的 Edit 入口，不替换 YOLO，不迁移历史 edit 会话。
7. `auto` 仍未实现，guarded 不是完整 Auto Mode classifier，不承诺未知语法安全；未命中/unsupported 沿原策略，不表示安全。

## 匹配器规则（识别层）

对 bash 命令做选项表级语法解析（`handlers/guarded/`），仅识别，不做文件系统探测：

- 九类规则：`rm -r|批量`、`git clean` 有效 force、`git checkout/reset` 危险回退、`find -delete`（仅 POSIX/Git Bash）、`rsync --delete*`、CMD `rd/rmdir /s`、CMD `del/erase`（有目标）、`robocopy /MIR|/PURGE`（可靠定位，`/L` 列举不命中）。
- rm：递归与批量共用原 ruleId；单个普通文件、单个纯动态目标、引用/转义的字面 glob 不命中；`rm -- -r` 不命中，`rm -- -r -f` 因两目标命中；帮助/交互选项不能取消已知危险证据。
- CMD 开关不区分大小写，内建命令粘连开关（`rd/s/q target`、`rd target/s/q`）按粘连识别；引用路径中的斜杠与重定向目标不拆成开关；无目标及独立 `/?` 不命中。
- find 按已声明 arity 跳过谓词与输出参数；`-exec/-execdir/-ok/-okdir` 载荷只跳过不递归匹配；未知 arity 停止分析，保留此前可靠的命中；BSD `-d/-x` 前置选项按零参数消费。
- wrapper 仅剥 `env`/`time`/`sudo`；不扩展 xargs/find-exec/njs；不解释 PowerShell、brace/变量/命令替换、脚本、远端删除、rimraf/shred/truncate。
- 逐词事实：内部 `hasUnquotedGlob`；方言（posix/cmd）传入规则调度，不把 POSIX 路径按 CMD 解释。
- ruleId 形如 `safety.bash.remove-critical-path`。

## 审批链（状态所有者与事件顺序）

```text
bash handler resolveBashPermissionCapability(mode=guarded)
  → matchDangerousCommand(command, dialect)
  → matched: ToolEntry.userApprovalRule = ruleId
  → PermissionService：!planEnabled && guarded && userApprovalRule
      → ask + approvalMode: "user-once"（yolo|guarded 共享 mode.yolo allow 基础策略）
  → executor permission-flow：user-once 决策 runHooks:false、跳过 hook-modify 重判
  → broker.requestPermission（已登记 responder 竞速）
  → 用户单次批准/拒绝 → 原 tool result；迟到响应无效
```

- 所有权：session/mode 属 CLI/runtime；broker 登记信号与最内层 origin 由既有链路透传；UI 只持有草稿与 pending 展示。
- guarded 下 `DenyPermissionBroker`（未接 broker 即拒绝的默认实现）抛 ConfigurationError 而不是静默拒绝——静默拒绝会让模型误以为命令本身失败。
- guarded 异常转换：broker/交互异常转 `ToolExecutionFailed`/`ToolCancelled`/`PermissionTimeout`，不伪装成 `PermissionDenied`（后者会被模型当作策略拒绝并改写方案）。
- 入参快照：guarded 决策前 `structuredClone` + 深冻结审批入参（`snapshotPermissionInput`），并钉住 workingDirectory，防批准后输入被改。

## 协议与持久化

- `TurnInputIntentMetadata.mode`、`PendingPermission.approvalMode`、shared execution-state / task-mode schema、adapters config/codecs、automation/off-peak/plan-mode 工具 schema 同步加 guarded。
- 无数据库迁移、无新增保护 boolean；历史 edit 可回显。

## 验收场景

1. build/edit/plan/yolo/auto 行为与 v3.14.3 完全一致（回归）。
2. guarded 下 `ls`、`git status` 等普通命令零审批直接执行。
3. guarded 下 `rm -rf src`、`rm -r -f a b`、`find . -name '*.log' -delete`、`rsync -a --delete a/ b/`、`git clean -fd`、CMD `rd /s /q dir`、`robocopy a b /MIR` 各触发一次 user-once 审批。
4. 批准 → 命令真实执行一次，产生原 tool result；拒绝 → 不执行，返回取消/拒绝结果；迟到批准无效。
5. Hook allow 不代批；Full access/永久授权不放行危险请求。
6. `rm file.txt`（单个普通文件）、`rm -- -r`、引用 glob 不命中，沿 YOLO 执行。
7. planEnabled=true 时 guarded 受 Plan 约束，不走危险审批。
8. guarded 会话派生 yolo 子任务 → 子任务保持 guarded；显式 build 子任务保留 build。
9. 模式切换器显示"自主模式"，中英文文案、浅蓝 shield 图标；保存恢复后 mode 值不变。
10. unsupported 语法（PowerShell、深层嵌套展开）不崩溃、不误报命中，沿 YOLO 策略并在注释中标注"不表示安全"。

## 测试映射（本地 node:test，无 vitest：仓库测试入口是 `npx tsx --test`）

| 验收场景 | 测试 | 数量 |
| --- | --- | --- |
| 2、3、6、10（matcher 全规则 + 方言边界） | `apps/zcode-cli/packages/core/src/tool/handlers/guarded/command.test.ts` | 260 |
| 5、7、8（模式语义/继承/自动化记录保住显式值） | `apps/zcode-cli/packages/core/src/permission/guarded-mode.test.ts` | 11 |
| 4、5（user-once 生命周期、Hook 不代批、快照与 cwd 钉住、迟到批准、超时/取消/模式切换清理） | `apps/zcode-cli/packages/core/src/tool/executor/guarded-approval.test.ts` | 116 |
| 交互完成（AskUserQuestion 在两种模式下语义一致、Hook 改写重判） | `apps/zcode-cli/packages/core/src/tool/handlers/guarded-user-interaction.test.ts` | 11 |
| 5（v3 协议选项收敛 user-once） | `apps/zcode-cli/packages/bootstrap/src/permission-options-guarded.test.ts` | 2 |
| 5、9（v4 投影两条投放链 + replay 一致、抑制 fullAccess） | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/guarded-projection.test.ts` | 1 |
| 9（wire 枚举 round-trip、目录文案、历史 edit 回显不回退） | `packages/shared/src/guarded-mode.test.ts` | 4 |
| 1（v3.14.3 行为回归） | 既有本地测试套件（spawn-session、product-projection、ui 套件） | 33 |

合计 405 条，全部通过（`npx tsx --test`）。

**未移植**（依赖本地不存在的测试基建，如实记录）：
- `guarded-subagent.test.ts`（需官方 4 个 runtime test helper，约 415 行；`inheritPermissionMode` 的接线本身由 guarded-mode 测试的纯函数断言 + 逐行对照官方 diff 覆盖）。
- `guarded-workflow.test.ts` / `guarded-interaction-lifecycle.test.ts`（需 bootstrap `registry-backed-test-app.ts` 197 行 helper）；dwf actor 权限继承的 journal 链路由本 spec「子任务继承」规则 5 第 2 类与实现注释钉住。
- desktop e2e guarded 用例（官方 manual-review，需真机/录屏取证）。
