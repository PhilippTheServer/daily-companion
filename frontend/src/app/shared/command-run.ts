import { inject, signal } from '@angular/core';
import { errorText } from '../core/api/errors';
import { Notices } from '../core/notices';

/**
 * Runs one-shot commands: a busy guard, and an idempotency key per attempt that is reused
 * when the same `signature` is retried after a failure and renewed after a success. Failures
 * show as inline `failure` text, not as a notice. Create it in an injection context.
 */
export class CommandRun {
  private readonly notices = inject(Notices);
  private attempt = { signature: '', key: crypto.randomUUID() };

  readonly busy = signal(false);
  readonly failure = signal<string | null>(null);

  /** @param explain turns a failure into its text; defaults to `errorText`. */
  constructor(private readonly explain: (error: unknown) => string = errorText) {}

  /** Forget the last failure. */
  clear(): void {
    this.failure.set(null);
  }

  /** Send once; false while busy or when the command failed, true after a success. */
  async run(
    signature: string,
    send: (idempotency_key: string) => Promise<{ warnings?: string[] }>,
  ): Promise<boolean> {
    if (this.busy()) {
      return false;
    }
    if (this.attempt.signature !== signature) {
      this.attempt = { signature, key: crypto.randomUUID() };
    }
    this.busy.set(true);
    this.failure.set(null);
    try {
      const response = await send(this.attempt.key);
      this.attempt = { signature: '', key: crypto.randomUUID() };
      this.notices.warnings(response.warnings);
      return true;
    } catch (error) {
      this.failure.set(this.explain(error));
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
