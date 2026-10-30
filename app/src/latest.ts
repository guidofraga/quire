// A debounced request whose answer is used only while it is the newest: live evaluation
// asks the engine again after every edit, and a slow answer must never replace a newer one.

export interface Latest {
  /** Ask again after the delay; any answer to an earlier call is dropped from now on. */
  schedule(): void;
  /** Whether an answer is still to come for the latest call. */
  pending(): boolean;
}

export function latestOnly<T>(
  request: () => Promise<T>,
  use: (answer: T) => void,
  fail: (error: unknown) => void,
  delay: number,
): Latest {
  let seq = 0;
  let waiting = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule() {
      clearTimeout(timer);
      waiting = true;
      // numbered when scheduled, not when sent: an answer still on its way when the next
      // call comes (an edit, another document opened) is already out of date
      const mine = ++seq;
      timer = setTimeout(async () => {
        try {
          const answer = await request();
          if (mine === seq) use(answer);
        } catch (e) {
          if (mine === seq) fail(e);
        } finally {
          if (mine === seq) waiting = false;
        }
      }, delay);
    },
    pending: () => waiting,
  };
}
