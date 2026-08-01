/**
 * The **global master lease** (ADR-0041 V1): at most one master session runs in the whole
 * daemon at a time, across every target repo.
 *
 * This is deliberately simpler than per-root leasing, and the simplicity is the feature. The
 * decision ledger (ADR-0040) fails *closed* on two active records claiming one key with no
 * supersession between them — which is exactly what two masters writing concurrently would
 * produce. A global lease makes that race unrepresentable rather than merely unlikely, and
 * costs only latency on a queue that is, by construction, rare.
 *
 * One instance is created by the composition root and shared by every per-repo reconciler
 * (the same shape as the shared build budget, ADR-0020). It is in-process state, not durable:
 * on restart no master is running, so a fresh lease is exactly correct.
 */

/** A held lease, keyed so only its holder can release it. */
export interface MasterLeaseHandle {
  readonly key: string;
  release(): void;
}

export class MasterLease {
  private holder: string | null = null;

  /** Whether any master session currently holds the lease. */
  isHeld(): boolean {
    return this.holder !== null;
  }

  /** The current holder's key, or null. Surfaced for logging/diagnostics. */
  heldBy(): string | null {
    return this.holder;
  }

  /**
   * Take the lease for `key`, or return null when it is already held. Re-acquiring for the
   * *same* key also returns null: a second attempt to run the same master task is a bug the
   * lease should surface, not silently permit.
   */
  acquire(key: string): MasterLeaseHandle | null {
    if (this.holder !== null) {
      return null;
    }
    this.holder = key;
    let released = false;
    return {
      key,
      release: (): void => {
        // Idempotent and holder-checked: a double release (a `finally` plus an explicit one)
        // must never hand the lease away from a *later* holder.
        if (released || this.holder !== key) {
          return;
        }
        released = true;
        this.holder = null;
      },
    };
  }
}
