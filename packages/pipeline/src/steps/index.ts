import { registerStep } from './registry';
import { extractStep } from './extract';
import { classifyStep } from './classify';
import { tagStep } from './tag';
import { filterStep } from './filter';
import { webhookStep } from './webhook';
import { transformStep } from './transform';

export function registerAllSteps(): void {
  registerStep(extractStep);
  registerStep(classifyStep);
  registerStep(tagStep);
  registerStep(filterStep);
  registerStep(webhookStep);
  registerStep(transformStep);
}

export { getStep, hasStep } from './registry';
export type { StepContext, StepOutput, StepResult, StepImplementation } from './types';
