// ============================================================
// Session Spawn Port - create a peer task session boundary
// ============================================================

export interface SessionSpawnRequest {
  /** 发起 spawn 的父会话 id；新会话 record 挂 parentSessionId 并标记来源（防递归）。 */
  parentSessionId: string;
  /** 新会话的首条用户输入（任务提示）。 */
  prompt: string;
  /** 可选标题；缺省由宿主按既有标题自动生成。 */
  title?: string;
  /** 继承父会话模型，由执行器注入（结构化 provider/model），不来自模型输入。 */
  model?: { providerId: string; modelId: string };
  /**
   * 目标本地项目路径；缺省=父会话工作区（本地链路）。
   * 其他路径经宿主反向 RPC 创建（宿主按最近项目白名单裁决）。
   */
  workspace?: string;
}

export interface SessionSpawnResult {
  sessionId: string;
}

/**
 * 由受信任 Host（zcode-protocol app-server）注入：把「创建平级任务会话并投递首条输入」
 * 委托给与 GUI createSession 相同的命令链路。端口缺席（TUI/headless/subagent/spawn 来源
 * 会话）即工具不注册，与 AutomationPort/OffPeakPort 同一模式。
 */
export interface SessionSpawnPort {
  spawn(
    request: SessionSpawnRequest,
    options?: { signal?: AbortSignal },
  ): Promise<SessionSpawnResult>;
}
