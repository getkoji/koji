import type { CompiledPipeline } from './types.js';

export interface PipelinePath {
  stepIds: string[];
  cost: number;
  description: string;
}

/**
 * Enumerate all paths from entry to terminal steps and compute per-path cost.
 * Returns paths sorted by cost descending.
 */
export function calculatePipelineCosts(pipeline: CompiledPipeline): {
  maxCostPerDoc: number;
  paths: PipelinePath[];
} {
  const stepCostMap = new Map(pipeline.steps.map((s) => [s.id, s.costPerDoc]));
  const adj = new Map<string, string[]>();

  for (const step of pipeline.steps) {
    adj.set(step.id, []);
  }
  for (const edge of pipeline.edges) {
    adj.get(edge.from)?.push(edge.to);
  }

  const terminalSet = new Set(pipeline.terminalStepIds);
  const paths: PipelinePath[] = [];

  // DFS from entry step, collecting all paths to terminal steps
  function dfs(current: string, path: string[], cost: number) {
    path.push(current);
    cost += stepCostMap.get(current) ?? 0;

    const neighbors = adj.get(current) ?? [];
    if (neighbors.length === 0 || terminalSet.has(current) && neighbors.length === 0) {
      // Terminal step — record the path
      paths.push({
        stepIds: [...path],
        cost: Math.round(cost * 1e6) / 1e6, // avoid floating-point dust
        description: path.join(' → '),
      });
    } else {
      for (const next of neighbors) {
        dfs(next, path, cost);
      }
    }

    path.pop();
  }

  dfs(pipeline.entryStepId, [], 0);

  // Sort by cost descending
  paths.sort((a, b) => b.cost - a.cost);

  return {
    maxCostPerDoc: paths[0]?.cost ?? 0,
    paths,
  };
}
