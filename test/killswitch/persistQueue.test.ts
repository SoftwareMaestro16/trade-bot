import { describe, expect, it } from "vitest";
import { createPersistQueue } from "../../src/killswitch/persistQueue.js";

describe("createPersistQueue", () => {
  it("runs calls to completion in ENQUEUE order, even when the earlier call's own promise settles LATER", async () => {
    const order: string[] = [];
    const enqueue = createPersistQueue();

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = enqueue(async () => {
      await firstGate; // deliberately slow — simulates the "earlier trigger, slower network round-trip" case
      order.push("first");
    });
    const second = enqueue(async () => {
      order.push("second"); // fast, but must still wait for `first` to finish first
    });

    // Give `second` every opportunity to run ahead if the queue were broken.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual([]); // neither has run yet — `second` correctly waited on `first`

    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["first", "second"]); // enqueue order preserved despite first being slower
  });

  it("a failed call does not wedge the queue — later calls still run", async () => {
    const order: string[] = [];
    const enqueue = createPersistQueue();

    const first = enqueue(async () => {
      throw new Error("simulated DB write failure");
    });
    const second = enqueue(async () => {
      order.push("second");
    });

    await expect(first).rejects.toThrow("simulated DB write failure");
    await second;
    expect(order).toEqual(["second"]);
  });

  it("each call's own return value is preserved and not mixed up with another call's", async () => {
    const enqueue = createPersistQueue();
    const [a, b, c] = await Promise.all([
      enqueue(async () => "A"),
      enqueue(async () => "B"),
      enqueue(async () => "C"),
    ]);
    expect([a, b, c]).toEqual(["A", "B", "C"]);
  });

  it("a call that throws SYNCHRONOUSLY (before its first await) still releases the queue for the next call", async () => {
    const order: string[] = [];
    const enqueue = createPersistQueue();

    const first = enqueue(() => {
      throw new Error("sync throw, no await ever reached");
    });
    const second = enqueue(async () => {
      order.push("second");
    });

    await expect(first).rejects.toThrow("sync throw");
    await second;
    expect(order).toEqual(["second"]);
  });

  it("two independently created queues do not serialize against each other", async () => {
    const enqueueA = createPersistQueue();
    const enqueueB = createPersistQueue();
    const order: string[] = [];

    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const a = enqueueA(async () => {
      await gateA;
      order.push("a");
    });
    const b = enqueueB(async () => {
      order.push("b"); // a different queue instance — must not wait on queue A at all
    });

    await b; // resolves immediately, unblocked by A's still-pending gate
    expect(order).toEqual(["b"]);

    releaseA();
    await a;
    expect(order).toEqual(["b", "a"]);
  });
});
