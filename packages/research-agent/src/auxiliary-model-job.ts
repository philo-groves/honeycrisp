import type { ResearchProfileModelJob } from './research-profile.js';

export const AUXILIARY_MODEL_JOB_NAMES = [
  'sessionTitle',
  'promptGeneration',
  'goalSuggestions',
  'memoryCuration',
  'shellReview',
] as const;

export type AuxiliaryModelJobName = (typeof AUXILIARY_MODEL_JOB_NAMES)[number];
export type AuxiliaryModelEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AuxiliaryModelProvider = 'openai-codex' | 'anthropic' | 'xai' | 'zai' | 'openrouter';

export interface AuxiliaryModelRoute {
  provider: AuxiliaryModelProvider;
  model: string;
  effort: AuxiliaryModelEffort;
}

export interface ResolveAuxiliaryModelRouteInput {
  jobName: AuxiliaryModelJobName;
  job?: ResearchProfileModelJob | null;
  provider: AuxiliaryModelProvider;
  requestedModel?: string | null;
  requestedEffort?: string | null;
  configuredModel?: string | null;
  configuredEffort?: string | null;
  fallbackModel?: string | null;
  fallbackEffort: AuxiliaryModelEffort;
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const EFFORTS = new Set<AuxiliaryModelEffort>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export function resolveAuxiliaryModelRoute(input: ResolveAuxiliaryModelRouteInput): AuxiliaryModelRoute {
  const job = applicableModelJob(input.job ?? undefined, input.provider);
  const model = firstText(input.requestedModel, job?.model, input.configuredModel, input.fallbackModel);
  if (!model) throw new Error(`Auxiliary model job ${input.jobName} has no configured model for ${input.provider}.`);
  if (!MODEL_ID.test(model)) throw new Error(`Auxiliary model job ${input.jobName} has an invalid model id.`);
  const effort = firstText(input.requestedEffort, job?.effort, input.configuredEffort, input.fallbackEffort);
  if (!effort || !EFFORTS.has(effort as AuxiliaryModelEffort)) {
    throw new Error(`Auxiliary model job ${input.jobName} has unsupported reasoning effort ${effort ?? ''}.`);
  }
  return { provider: input.provider, model, effort: effort as AuxiliaryModelEffort };
}

export function applicableModelJob(
  job: ResearchProfileModelJob | undefined,
  provider: AuxiliaryModelProvider,
): ResearchProfileModelJob | undefined {
  if (!job?.provider) return job;
  if (job.provider === provider) return job;
  return provider === 'openai-codex' && job.provider === 'openai' ? job : undefined;
}

function firstText(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const text = value?.trim();
    if (text) return text;
  }
  return null;
}
