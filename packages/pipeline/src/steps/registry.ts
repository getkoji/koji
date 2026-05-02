import type { StepType } from '../types';
import type { StepImplementation } from './types';

const registry = new Map<StepType, StepImplementation>();

export function registerStep(impl: StepImplementation): void {
  registry.set(impl.type, impl);
}

export function getStep(type: StepType): StepImplementation | undefined {
  return registry.get(type);
}

export function hasStep(type: StepType): boolean {
  return registry.has(type);
}
