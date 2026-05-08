import { registerStep } from './registry';
import { extractStep } from './extract';
import { classifyStep } from './classify';
import { tagStep } from './tag';
import { filterStep } from './filter';
import { webhookStep } from './webhook';
import { transformStep } from './transform';
import { splitStep } from './split';

export function registerAllSteps(): void {
  registerStep(extractStep);
  registerStep(classifyStep);
  registerStep(tagStep);
  registerStep(filterStep);
  registerStep(webhookStep);
  registerStep(transformStep);
  registerStep(splitStep);
}

export { getStep, hasStep } from './registry';
export type { StepContext, StepOutput, StepResult, StepImplementation } from './types';
