/**
 * Minimal typing for the Prioritized Task Scheduling API.
 *
 * Not yet in TypeScript's DOM library, and `slicedRunner` feature-detects it
 * before use, so this only has to describe the shape we call.
 */
interface SchedulerPostTaskOptions {
  priority?: 'user-blocking' | 'user-visible' | 'background';
  signal?: AbortSignal;
  delay?: number;
}

interface Scheduler {
  postTask<T>(callback: () => T, options?: SchedulerPostTaskOptions): Promise<T>;
}

declare var scheduler: Scheduler | undefined;
