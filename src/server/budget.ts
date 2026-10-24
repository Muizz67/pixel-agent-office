export interface BudgetLimits {
  maxTokens: number;
  maxToolCalls: number;
}

export interface BudgetWarning {
  kind: 'tokens' | 'tools' | 'time';
  used: number;
  limit: number;
}

export class BudgetExceededError extends Error {
  constructor(
    message: string,
    readonly kind: 'tokens' | 'tools' | 'time',
  ) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

/**
 * Tracks per-run usage and stops work before it exceeds configured bounds.
 * Warnings are emitted once per dimension at 80%.
 */
export class RunBudget {
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  readonly startedAt: number;
  private readonly warned = new Set<'tokens' | 'tools' | 'time'>();

  constructor(
    private readonly limits: BudgetLimits,
    initial: { inputTokens: number; outputTokens: number; toolCalls: number },
    private readonly onWarning: (warning: BudgetWarning) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.inputTokens = initial.inputTokens;
    this.outputTokens = initial.outputTokens;
    this.toolCalls = initial.toolCalls;
    this.startedAt = now();
  }

  get tokensUsed(): number {
    return this.inputTokens + this.outputTokens;
  }

  assertTokensAvailable(): void {
    if (this.tokensUsed >= this.limits.maxTokens) {
      throw new BudgetExceededError(
        `Token budget exhausted (${this.tokensUsed}/${this.limits.maxTokens}).`,
        'tokens',
      );
    }
    this.warnIfNeeded('tokens', this.tokensUsed, this.limits.maxTokens, 0.8);
  }

  reserveToolCall(): void {
    if (this.toolCalls >= this.limits.maxToolCalls) {
      throw new BudgetExceededError(
        `Tool-call budget exhausted (${this.toolCalls}/${this.limits.maxToolCalls}).`,
        'tools',
      );
    }
    this.toolCalls += 1;
    this.warnIfNeeded('tools', this.toolCalls, this.limits.maxToolCalls, 0.8);
  }

  addTokens(inputTokens: number, outputTokens: number): void {
    this.inputTokens += Math.max(0, inputTokens);
    this.outputTokens += Math.max(0, outputTokens);
    this.assertTokensAvailable();
  }

  elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  timeWarning(runTimeoutMs: number): void {
    this.warnIfNeeded('time', this.elapsedMs(), runTimeoutMs, 0.8);
  }

  private warnIfNeeded(
    kind: 'tokens' | 'tools' | 'time',
    used: number,
    limit: number,
    threshold: number,
  ): void {
    if (this.warned.has(kind)) return;
    if (used < limit * threshold) return;
    this.warned.add(kind);
    this.onWarning({ kind, used, limit });
  }
}
