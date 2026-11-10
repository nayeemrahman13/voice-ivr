export type Ranked = {
  confidence: number;
  unclear: boolean;
};

export function firstConfident<T extends Ranked>(tasks: Promise<T>[], threshold: number): Promise<T> {
  if (tasks.length === 0) {
    return Promise.reject(new Error("Type a reply or record one."));
  }

  return new Promise((resolve, reject) => {
    let open = tasks.length;
    let settled = false;
    let best: T | undefined;

    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    for (const task of tasks) {
      task.then(
        (value) => {
          if (settled) return;
          if (!value.unclear && value.confidence >= threshold) {
            finish(value);
            return;
          }
          if (!best || prefer(value, best)) best = value;
          open -= 1;
          if (open === 0) {
            if (best) finish(best);
            else reject(new Error("Classification failed."));
          }
        },
        () => {
          if (settled) return;
          open -= 1;
          if (open === 0) {
            if (best) finish(best);
            else reject(new Error("Classification failed."));
          }
        },
      );
    }
  });
}

function prefer(next: Ranked, current: Ranked): boolean {
  if (next.unclear !== current.unclear) return !next.unclear;
  return next.confidence > current.confidence;
}
