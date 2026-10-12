import { getModelInfo, providerLabel } from './registry.js';

/**
 * Appends the identity of the model that is actually answering. Without it a local model happily
 * claims to be "from OpenAI" (training-data prior), which then reads as a bug in the app.
 */
export function withModelIdentity(system: string, modelId: string, env: NodeJS.ProcessEnv = process.env): string {
  const info = getModelInfo(modelId, env);
  const identity = `You are running as the model "${info.label}" (id: ${info.id}, provider: ${providerLabel(info.provider)}). If asked which model or company you are, answer exactly this and do not claim to be any other model.`;
  return system ? `${system}\n\n${identity}` : identity;
}
