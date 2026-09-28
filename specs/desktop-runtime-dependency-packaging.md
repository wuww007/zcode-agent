# Spec：desktop 运行时依赖打包防线（asar 注入闭包 + bundle 机械校验）

> 2026-09-28：因 3.14.3 正式包启动即报 `Cannot find package 'yaml'` 而建立。复盘发现
> 漏包并非孤例——已安装 3.14.3 的 app.asar 里同时缺 `argparse`、`source-map-js`、
> `@opentelemetry/sdk-logs` 等 6 个闭包模块，只是运行时路径尚未踩到。历史同类案例：
> `ms`、`asn1`、`protobufjs`、`pngjs`、`yauzl/pend`、`module-details-from-path`。

## 问题

- tsup（main/host/scheduler）**默认把 desktop `package.json` 的全部生产依赖外置**为
  运行时裸包 import（`desktopNodeRuntimeExternals` 只是其中显式声明的子集）；产物在
  正式包里必须能从 `app.asar` 内部解析这些包。
- pnpm hoisted 布局下 electron-builder 的依赖收集器会不稳定地漏拷直接/传递依赖，
  产物表现为「安装包能生成，用户启动后主进程 `ERR_MODULE_NOT_FOUND` 即崩」。
- 防线是两份机械名单，历史上多次「踩到一颗补一颗」，名单没有随 tsup 外置面同步，
  最终 yaml 漏出。

## 规则（不变量）

1. **凡是被主进程 / 宿主 / scheduler / preload 产物顶层 import 或运行时 require 的
   裸包，必须同时登记在两份名单**：
   - 注入名单 `REQUIRED_ASAR_RUNTIME_MODULES`
     （`packages/desktop/electron-builder.config.js`，afterPack 按闭包根注入）；
   - 校验名单 `requiredRuntimeModules`
     （`packages/desktop/scripts/bundle.mjs`，bundle 后对最终 asar 机械校验）。
   口径：**校验要求的模块必须有人负责补齐，注入的必须被校验**——两份名单内容一致。
2. 名单登记的是**闭包根**：`collectRuntimeModuleClosureEntries` 按
   `dependencies` / `optionalDependencies` 递归展开；`peerDependencies` 不会被递归，
   需要 peer 运行时的包（如 `@babel/runtime`）必须显式登记。
3. `electron`、`node-pty` 不走名单：前者是运行时本体，后者走 `asarUnpack` prebuild
   专属机制（`restoreTargetNodePtyPrebuild` + `assertPackagedNodePtyPrebuild`）。
4. 新增 / 升级 desktop 生产依赖或 tsup external 时的固定动作：跑**产物裸包扫描**
   （对 `out/{main,host,scheduler,preload}` 抓 `from"…" / require("…") / import("…")`
   的裸包名），逐一与两份名单对账，缺失即补。
5. 正式包启动报 `Cannot find package 'x'` 的处置：先 `asar list` 对账确认，再把 `x`
   按闭包根登记进两份名单并重打包；**禁止只在注入名单补一颗**（那只是把发现时机从
   用户启动推迟到下次另一个包缺失）。

## 状态所有权

| 状态                       | 所有者                                                            | 说明                                                 |
| -------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------- |
| 哪些包必须进 asar（事实）  | 两份名单（本 spec 为口径出处）                                    | 名单是闭包根，不是穷举；展开由闭包收集器负责         |
| 注入执行                   | `electron-builder.config.js` afterPack `injectHoistedRuntimeModulesIntoAsar` | 只补缺失包；齐全时跳过 asar 重写               |
| 出包门禁                   | `bundle.mjs` `verifyPackagedRuntimeDependencies`                  | 最终 asar 缺任一闭包模块 → build 直接失败，坏包不流出 |
| 依赖解析事实               | workspace node_modules 实际布局（`runtimeModuleLookupRoots` 四级查找） | 解析不到的根 warn+skip，注入与校验同口径       |

## 验收场景

1. `pnpm --dir packages/desktop bundle`（mac arm64）全链路成功，校验阶段无缺失报错。
2. 人为从打包产物 app.asar 移除 `node_modules/yaml` → bundle 校验失败，构建被拦截。
3. 运行时依赖已齐全时，afterPack 日志出现 `runtime modules already complete, skip
   app.asar rewrite`，不重复重写 asar。
4. 产物裸包扫描得到的每个裸包名，都能被注入闭包（含递归子依赖）覆盖。
