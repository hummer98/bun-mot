import { BunMotClient } from "./client";
import { BunMotError } from "./errors";
import { isGetTextResult, isWaitForSelectorResult } from "./types";
import type { EvaluateResult } from "./types";
import type { CommandRequest } from "./commands";

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
}
