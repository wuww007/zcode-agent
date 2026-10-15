// 任务页「当前生成速度」的流中估值（见 specs/task-page-token-speed.md）。
//
// 流式协议不带 token 计数：provider 只在请求结束的 usage 里给 outputTokens，
// ModelStreamingPayload 只有 delta 文本。因此流中速率 = 「模型输出的流式追加字符
// → 估算 token」的滑动窗口值，显示时带 ≈ 前缀；请求完成后的精确值由 CLI 投影写在
// usage.lastRequest（calculateOutputTps），UI 直接读协议字段。
//
// 纯逻辑：时钟由调用方传入，便于单测；不持有 React 状态，不持久化，不进协议。
import { countEstimatedTokenChars, estimateTokensFromCharCounts } from "@zcode/shared";
import type { ConversationDelta, ConversationRow } from "@zcode/shared/zcode-protocol-v4";

/** 滑动窗口：过短抖动大，过长跟不上节奏。 */
export const GENERATION_SPEED_WINDOW_MS = 3_000;
/** 窗口时长不足（开流瞬间）不展示，避免把首包尖峰当速度。 */
export const GENERATION_SPEED_MIN_WINDOW_MS = 400;
/** 窗口内估算 token 太少（零星字符）不展示。 */
const MIN_WINDOW_TOKENS = 5;

export interface GenerationSpeedSample {
  tokensPerSecond: number;
  /** 窗口内累计的估算 token（≈ 值）。 */
  windowTokens: number;
  windowMs: number;
}

/**
 * tracker 样本时间与渲染读数必须共用这一个时钟（performance.now 基准）；
 * 不要与 Date.now 混用，跨时钟差会直接放大成错误的速率。
 */
export function generationSpeedNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

interface CharSample {
  at: number;
  cjkChars: number;
  otherChars: number;
}

/**
 * 行内可计数的模型输出文本。
 * 只含模型生成的字段：正文/思考的 text、工具调用的 inputText；
 * 工具执行输出（output.text）与子代理摘要（summaryText）不是本次生成的 token。
 */
function countableRowText(row: ConversationRow): string | null {
  switch (row.kind) {
    case "assistantText":
    case "reasoning":
      return row.text;
    case "toolCall":
      return row.inputText;
    default:
      return null;
  }
}

/** row.delta 的 path 白名单：语义见 countableRowText，两者必须同步演进。 */
function isCountableDeltaPath(
  path: Extract<ConversationDelta, { op: "row.delta" }>["path"],
): boolean {
  return path === "text" || path === "inputText";
}

/**
 * 每个会话投影 store 一个实例（随 store 生命周期存亡）。
 * 行内账本（rowId → 已计入字符数）用于两件事：
 * - 合并器（coalesceConversationDeltas 规则 3）可能用 row.upserted 吞掉同批 row.delta，
 *   只能按「新长度 − 已计入长度」的正差分补记，避免重复计数；
 * - snapshot/append 带入的既有文本不再计入（那是订阅前生成的历史）。
 */
export class GenerationSpeedTracker {
  private samples: CharSample[] = [];
  private readonly countedCharsByRowId = new Map<number, number>();

  /** 追加已通过 seq/epoch 校验的 delta 帧。`at` 取帧应用时刻（单调时钟）。 */
  observeDeltas(deltas: readonly ConversationDelta[], at: number): void {
    for (const delta of deltas) {
      switch (delta.op) {
        case "row.delta": {
          if (!isCountableDeltaPath(delta.path)) break;
          this.recordChars(delta.append, at);
          this.countedCharsByRowId.set(
            delta.rowId,
            (this.countedCharsByRowId.get(delta.rowId) ?? 0) + delta.append.length,
          );
          break;
        }
        case "row.appended":
        case "row.upserted": {
          const text = countableRowText(delta.row);
          if (text === null) break;
          const counted = this.countedCharsByRowId.get(delta.row.rowId);
          if (delta.op === "row.upserted" && counted !== undefined && text.length > counted) {
            // 追加型升格（被吞掉的 delta）：新增部分在尾部，按后缀切片估算。
            this.recordChars(text.slice(counted), at);
          }
          this.countedCharsByRowId.set(delta.row.rowId, text.length);
          break;
        }
        case "row.removed": {
          for (const rowId of [...this.countedCharsByRowId.keys()]) {
            if (rowId >= delta.fromRowId) this.countedCharsByRowId.delete(rowId);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  /** snapshot 整体替换后播种行内账本：已有文本不算作新生成。 */
  seedRows(rows: readonly ConversationRow[]): void {
    for (const row of rows) {
      const text = countableRowText(row);
      if (text === null) continue;
      if (!this.countedCharsByRowId.has(row.rowId)) {
        this.countedCharsByRowId.set(row.rowId, text.length);
      }
    }
  }

  /**
   * 当前时刻的窗口速率。无样本 / 窗口过短 / token 太少返回 null（调用方不展示）。
   * 停滞时窗口自然衰减到空：不残留过期的高速数字。
   */
  sample(now: number): GenerationSpeedSample | null {
    const windowFloor = now - GENERATION_SPEED_WINDOW_MS;
    let first = this.samples[0];
    while (first !== undefined && first.at < windowFloor) {
      this.samples.shift();
      first = this.samples[0];
    }
    if (first === undefined) return null;
    const windowMs = now - Math.max(first.at, windowFloor);
    if (windowMs < GENERATION_SPEED_MIN_WINDOW_MS) return null;
    let cjkChars = 0;
    let otherChars = 0;
    for (const sample of this.samples) {
      cjkChars += sample.cjkChars;
      otherChars += sample.otherChars;
    }
    const windowTokens = estimateTokensFromCharCounts(cjkChars, otherChars);
    if (windowTokens < MIN_WINDOW_TOKENS) return null;
    return {
      tokensPerSecond: (windowTokens * 1000) / windowMs,
      windowTokens,
      windowMs: Math.round(windowMs),
    };
  }

  /** 测试与显式生命周期清理用；生产路径不主动 reset（窗口自带时间衰减）。 */
  reset(): void {
    this.samples = [];
    this.countedCharsByRowId.clear();
  }

  private recordChars(text: string, at: number): void {
    if (text.length === 0) return;
    const { cjkChars, otherChars } = countEstimatedTokenChars(text);
    const last = this.samples.at(-1);
    if (last && last.at === at) {
      // 同一时刻的多条 delta 合并为一条样本，窗口求和不受影响。
      last.cjkChars += cjkChars;
      last.otherChars += otherChars;
      return;
    }
    this.samples.push({ at, cjkChars, otherChars });
  }
}
