import { simulateOneRun, computeMonteCarloResults } from './MonteCarloSimulator';
import type { MultiStageRocketConfig } from './MultiStageSystem';
import type { MonteCarloConfig, MonteCarloResults } from './MonteCarloSimulator';

export type WorkerMessageData = {
  type: 'start';
  baseConfig: MultiStageRocketConfig;
  mcConfig: MonteCarloConfig;
};

export type WorkerResponseData = 
  | { type: 'progress'; completed: number; total: number }
  | { type: 'complete'; results: MonteCarloResults };

self.onmessage = (e: MessageEvent<WorkerMessageData>) => {
  if (e.data.type === 'start') {
    const { baseConfig, mcConfig } = e.data;
    const allRuns = [];

    // Run all simulations synchronously in the worker thread.
    // No need to yield to the event loop because we're off the main thread.
    for (let i = 0; i < mcConfig.numberOfRuns; i++) {
      const run = simulateOneRun(i, baseConfig, mcConfig);
      allRuns.push(run);

      // Post progress every run
      self.postMessage({
        type: 'progress',
        completed: i + 1,
        total: mcConfig.numberOfRuns,
      });
    }

    // Compute final results
    const results = computeMonteCarloResults(allRuns);

    // Post complete message
    self.postMessage({
      type: 'complete',
      results,
    });
  }
};
