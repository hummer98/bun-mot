import { BunMotClient } from "./client";
import { BunMotError } from "./errors";
import {
  isClickResult,
  isFillResult,
  isGetAttributeResult,
  isGetLogsResult,
  isGetTextResult,
  isIsVisibleResult,
  isWaitForHiddenResult,
  isWaitForSelectorResult,
  isWaitForTextResult,
} from "./types";
import type { ConsoleLogEntry, EvaluateResult } from "./types";
import type { CommandRequest, TextMatcher } from "./commands";

export interface BunMotOptions {
  port: number;
  hostname?: string;
  /** T003 で複数 view を扱う際、すべてのリクエストに自動付与される識別子。v1 では bridge 側で無視される。 */
  viewId?: string;
  /** デフォルトタイムアウト (ms)。waitForSelector 等の `timeout` 未指定時に使われる。 */
  defaultTimeout?: number;
}

export class BunMot {
  private readonly client: BunMotClient;
  private readonly defaultTimeout: number;
  private readonly viewId: string | undefined;

  constructor(opts: BunMotOptions) {
    this.client = new BunMotClient(opts.port, opts.hostname ?? "127.0.0.1");
    this.defaultTimeout = opts.defaultTimeout ?? 5000;
    this.viewId = opts.viewId;
  }

  // §2 抜け漏れ#1: viewId 配線。各メソッドで request を組み立てる際に this.withViewId() で付与する。
  private withViewId<T extends CommandRequest>(req: T): T {
    return this.viewId === undefined ? req : { ...req, viewId: this.viewId };
  }

  async evaluate(expression: string): Promise<EvaluateResult> {
    const req: CommandRequest = this.withViewId({ type: "evaluate", expression });
    return await this.client.send(req);
  }

  async waitForSelector(selector: string, options?: { timeout?: number }): Promise<void> {
    const timeout = options?.timeout ?? this.defaultTimeout;
    const req: CommandRequest = this.withViewId({
      type: "waitForSelector",
      selector,
      timeout,
    });
    const result = await this.client.send(req);
    if (!isWaitForSelectorResult(result)) {
      throw new BunMotError(
        `waitForSelector: unexpected response shape: ${JSON.stringify(result)}`,
        "internal_error",
      );
    }
  }

  async getText(selector: string): Promise<string> {
    const req: CommandRequest = this.withViewId({ type: "getText", selector });
    const result = await this.client.send(req);
    if (!isGetTextResult(result)) {
      throw new BunMotError(
        `getText: unexpected response shape: ${JSON.stringify(result)}`,
        "internal_error",
      );
    }
    return result.text;
  }

  async click(selector: string): Promise<void> {
    const req: CommandRequest = this.withViewId({ type: "click", selector });
    const result = await this.client.send(req);
    if (!isClickResult(result)) {
      throw new BunMotError(
        `click: unexpected response shape: ${JSON.stringify(result)}`,
        "internal_error",
      );
    }
  }

  async fill(selector: string, value: string): Promise<void> {
    const req: CommandRequest = this.withViewId({ type: "fill", selector, value });
    const result = await this.client.send(req);
    if (!isFillResult(result)) {
      throw new BunMotError(
        `fill: unexpected response shape: ${JSON.stringify(result)}`,
        "internal_error",
      );
    }
  }

  async waitForHidden(selector: string, options?: { timeout?: number }): Promise<void> {
    const timeout = options?.timeout ?? this.defaultTimeout;
    const req: CommandRequest = this.withViewId({
      type: "waitForHidden",
      selector,
      timeout,
    });
    const result = await this.client.send(req);
    if (!isWaitForHiddenResult(result)) {
      throw new BunMotError(
        `waitForHidden: unexpected response shape: ${JSON.stringify(result)}`,
        "internal_error",
      );
    }
  }

  async waitForText(
    selector: string,
    text: string | RegExp,
    options?: { timeout?: number },
  ): Promise<void> {
    const timeout = options?.timeout ?? this.defaultTimeout;
    const matcher: TextMatcher =
      text instanceof RegExp
        ? { kind: "regex", source: text.source, flags: text.flags }
        : { kind: "string", value: text };
    const req: CommandRequest = this.withViewId({
      type: "waitForText",
      selector,
      text: matcher,
      timeout,
    });
    const result = await this.client.send(req);
    if (!isWaitForTextResult(result)) {
      throw new BunMotError(
        `waitForText: unexpected response shape: ${JSON.stringify(result)}`,
        "internal_error",
      );
    }
  }

  async isVisible(selector: string): Promise<boolean> {
    const req: CommandRequest = this.withViewId({ type: "isVisible", selector });
    const result = await this.client.send(req);
    if (!isIsVisibleResult(result)) {
      throw new BunMotError(
        `isVisible: unexpected response shape: ${JSON.stringify(result)}`,
        "internal_error",
      );
    }
    return result.visible;
  }

  async getAttribute(selector: string, attribute: string): Promise<string | null> {
    const req: CommandRequest = this.withViewId({
      type: "getAttribute",
      selector,
      attribute,
    });
    const result = await this.client.send(req);
    if (!isGetAttributeResult(result)) {
      throw new BunMotError(
        `getAttribute: unexpected response shape: ${JSON.stringify(result)}`,
        "internal_error",
      );
    }
    return result.value;
  }

  async getLogs(): Promise<ConsoleLogEntry[]> {
    const req: CommandRequest = this.withViewId({ type: "getLogs" });
    const result = await this.client.send(req);
    if (!isGetLogsResult(result)) {
      throw new BunMotError(
        `getLogs: unexpected response shape: ${JSON.stringify(result)}`,
        "internal_error",
      );
    }
    if (result.patchMissing) {
      // §3.5 M4: navigation / patch 未済を warn entry 1 件で通知 (空配列の代わり)。
      return [
        {
          level: "warn",
          message:
            "[bun-mot] console patch was not active when getLogs was called (page navigation may have reset it)",
          timestamp: Date.now(),
        },
      ];
    }
    if (result.droppedCount > 0) {
      return [
        {
          level: "warn",
          message: `[bun-mot] dropped ${result.droppedCount} earlier log entries`,
          timestamp: Date.now(),
        },
        ...result.entries,
      ];
    }
    return result.entries;
  }
}
