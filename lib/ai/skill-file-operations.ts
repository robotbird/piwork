import { SKILL_LIMITS } from "./skill-limits";

/** Bounded file operations. On failure, stop scheduling and await all in-flight
 * operations before returning control to rollback or sandbox cleanup. */
export async function forEachSkillFile<T>(
  files: readonly T[],
  concurrency: number,
  operation: (file: T) => Promise<unknown>
): Promise<void> {
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > SKILL_LIMITS.hostWriteConcurrency
  ) {
    throw new Error("Invalid skill file concurrency");
  }
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  const worker = async () => {
    while (!failed && cursor < files.length) {
      const index = cursor;
      cursor += 1;
      try {
        // biome-ignore lint/performance/noAwaitInLoops: bounded workers must finish writes before cleanup
        await operation(files[index]);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length) }, worker)
  );
  if (failed) {
    throw failure;
  }
}
