import type { CalcRunnerFactory } from '../calcTypes';
import { createSyncRunner } from './syncRunner';
import { createSlicedRunner } from './slicedRunner';

/**
 * The available execution strategies, so they can be compared on the machine
 * that matters rather than argued about on this one.
 */
export interface RunnerChoice {
  id: string;
  label: string;
  description: string;
  factory: CalcRunnerFactory;
}

export const RUNNERS: RunnerChoice[] = [
  {
    id: 'sliced',
    label: 'Time-sliced',
    description:
      'Main thread, 4ms slices, yielding between them. Same code, same profiler, nothing hidden.',
    factory: createSlicedRunner,
  },
  {
    id: 'sync',
    label: 'Synchronous',
    description: 'Main thread, run to completion. The baseline, and what the server does.',
    factory: createSyncRunner,
  },
];

export const DEFAULT_RUNNER = RUNNERS[0];
export { createSyncRunner, createSlicedRunner };
