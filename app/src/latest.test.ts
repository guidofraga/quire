import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { latestOnly } from "./latest";

describe("latestOnly", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A request whose answers arrive when the test says so. */
  function slow() {
    const answers: ((v: string) => void)[] = [];
    let n = 0;
    const request = () => {
      const k = ++n;
      return new Promise<string>((resolve) => answers.push(() => resolve(`answer ${k}`)));
    };
    return { request, answer: (i: number) => answers[i]("") };
  }

  it("drops an answer that arrives after the next call was scheduled", async () => {
    const { request, answer } = slow();
    const used: string[] = [];
    const live = latestOnly(request, (a) => used.push(a), vi.fn(), 30);
    live.schedule();
    await vi.advanceTimersByTimeAsync(30);
    // an edit (or another document) comes while the first answer is on its way
    live.schedule();
    answer(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(used).toEqual([]);
    expect(live.pending()).toBe(true);
    await vi.advanceTimersByTimeAsync(30);
    answer(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(used).toEqual(["answer 2"]);
    expect(live.pending()).toBe(false);
  });

  it("asks once for a burst of calls", async () => {
    const request = vi.fn(async () => "x");
    const live = latestOnly(request, vi.fn(), vi.fn(), 30);
    for (let i = 0; i < 5; i++) live.schedule();
    await vi.advanceTimersByTimeAsync(30);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("reports only the latest call's failure", async () => {
    let k = 0;
    const fails: ((e: Error) => void)[] = [];
    const request = () => new Promise<string>((_, reject) => fails.push(reject)).finally(() => k++);
    const fail = vi.fn();
    const live = latestOnly(request, vi.fn(), fail, 30);
    live.schedule();
    await vi.advanceTimersByTimeAsync(30);
    live.schedule();
    fails[0](new Error("old"));
    await vi.advanceTimersByTimeAsync(30);
    fails[1](new Error("new"));
    await vi.advanceTimersByTimeAsync(0);
    expect(k).toBe(2);
    expect(fail).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledWith(new Error("new"));
  });
});
