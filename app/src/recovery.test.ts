import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { keepRecovery, RECOVERY_DELAY } from "./recovery";
import { loadDoc, markSaved, state, updateRegion } from "./store";

const { saveRecovery, clearRecovery } = vi.hoisted(() => ({
  saveRecovery: vi.fn((_doc: unknown, _path: string | null) => Promise.resolve(null)),
  clearRecovery: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("./api", () => ({ api: { saveRecovery, clearRecovery } }));

const kept = () => (saveRecovery.mock.calls.at(-1)?.[0] as { regions: { expr: string }[] }).regions[0].expr;

describe("crash recovery", () => {
  beforeAll(() => keepRecovery());
  beforeEach(() => {
    vi.useFakeTimers();
    loadDoc({ format: "quire/1", meta: {}, regions: [{ id: "a", kind: "math", at: [0, 0], expr: "x := 1" }] }, null);
    saveRecovery.mockClear();
    clearRecovery.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("keeps the latest edits, not only the first", () => {
    updateRegion("a", { expr: "x := 2" });
    vi.advanceTimersByTime(RECOVERY_DELAY);
    expect(kept()).toBe("x := 2");
    updateRegion("a", { expr: "x := 3" });
    vi.advanceTimersByTime(RECOVERY_DELAY);
    expect(saveRecovery).toHaveBeenCalledTimes(2);
    expect(kept()).toBe("x := 3");
  });

  it("waits for a pause in typing, and drops the copy once saved", () => {
    updateRegion("a", { expr: "x := 4" });
    vi.advanceTimersByTime(RECOVERY_DELAY - 1);
    updateRegion("a", { expr: "x := 5" });
    vi.advanceTimersByTime(RECOVERY_DELAY - 1);
    expect(saveRecovery).not.toHaveBeenCalled();
    markSaved(state.rev);
    vi.advanceTimersByTime(RECOVERY_DELAY);
    expect(saveRecovery).not.toHaveBeenCalled();
    expect(clearRecovery).toHaveBeenCalled();
  });
});
