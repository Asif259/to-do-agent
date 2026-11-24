/** A fixed set of numbered worker lanes. `acquire` waits for a free lane; `release` hands it on. */
export class Lanes {
  private free: number[];
  private waiters: ((lane: number) => void)[] = [];

  constructor(size: number) {
    this.free = Array.from({ length: Math.max(1, size) }, (_, i) => i);
  }

  acquire(): Promise<number> {
    const lane = this.free.shift();
    if (lane !== undefined) return Promise.resolve(lane);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(lane: number): void {
    const next = this.waiters.shift();
    if (next) next(lane);
    else this.free.push(lane);
  }
}

/** Runs async jobs strictly one at a time, in the order they were submitted. */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job, job);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
