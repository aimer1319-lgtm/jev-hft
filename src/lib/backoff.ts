/**
 * "Slow down" after the model refuses a request for being over the rate limit: wait 5 seconds,
 * then twice as long after each further refusal, up to a minute. Any success resets it.
 */
export class Backoff {
  private until = 0;
  private nextMs: number;
  private readonly initialMs: number;
  private readonly maxMs: number;

  constructor(initialMs = 5000, maxMs = 60_000) {
    this.initialMs = initialMs;
    this.maxMs = maxMs;
    this.nextMs = initialMs;
  }

  waiting(now: number) {
    return now < this.until;
  }

  /**
   * Start a pause and return how long it is. Several calls refused at the same moment are one
   * event, so a refusal that arrives during a pause does not lengthen it.
   */
  fail(now: number): number {
    if (this.waiting(now)) return this.until - now;
    const wait = this.nextMs;
    this.until = now + wait;
    this.nextMs = Math.min(this.nextMs * 2, this.maxMs);
    return wait;
  }

  succeed() {
    this.nextMs = this.initialMs;
  }
}
