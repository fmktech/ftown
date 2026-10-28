/** Admission fence shared by mutating requests and session launches. */
export class UpdateAdmission {
  private closed = false;
  private readonly active = new Set<symbol>();
  private readonly waiters = new Set<() => void>();

  enter(): () => void {
    if (this.closed) throw new Error('Bridge update in progress');
    const token = Symbol();
    this.active.add(token);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active.delete(token);
      if (!this.active.size) for (const waiter of this.waiters) waiter();
    };
  }

  freeze(): void { this.closed = true; }
  reopen(): void { this.closed = false; }
  get isFrozen(): boolean { return this.closed; }

  async drain(timeoutMs: number): Promise<void> {
    if (!this.active.size) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); };
      const timer = setTimeout(() => { this.waiters.delete(done); reject(new Error('Update drain timed out')); }, timeoutMs);
      this.waiters.add(done);
      if (!this.active.size) done();
    });
  }
}

/** A response is eligible only after audit/seal and actual transport handoff. */
export class UpdateResponseTicket {
  private sealed = false;
  private delivered = false;
  private finished = false;
  constructor(private readonly start: () => void, private readonly abort: () => void) {}
  markSealed(): void { if (!this.finished) { this.sealed = true; this.maybeStart(); } }
  markDelivered(): void { if (!this.finished) { this.delivered = true; this.maybeStart(); } }
  cancel(): void { if (!this.finished) { this.finished = true; this.abort(); } }
  private maybeStart(): void {
    if (!this.sealed || !this.delivered || this.finished) return;
    this.finished = true;
    queueMicrotask(this.start);
  }
}
