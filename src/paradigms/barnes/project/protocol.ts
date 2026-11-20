import { analysisParameterErrors } from '../params';
import type { AnalysisParams } from '../types';

export interface ProtocolPreset {
  readonly format: 'barnes-maze-protocol';
  readonly formatVersion: 1;
  readonly name: string;
  readonly revision: string;
  readonly params: AnalysisParams;
}

export function parseProtocol(value: unknown): ProtocolPreset {
  if (!value || typeof value !== 'object') throw new Error('Choose a Barnes maze protocol file.');
  const p = value as Partial<ProtocolPreset>;
  if (p.format !== 'barnes-maze-protocol' || p.formatVersion !== 1) {
    throw new Error('Unsupported protocol format.');
  }
  for (const field of ['name', 'revision'] as const) {
    if (typeof p[field] !== 'string' || !p[field].trim() || p[field].length > 80) {
      throw new Error(`Protocol ${field} must contain 1 to 80 characters.`);
    }
  }
  const errors = analysisParameterErrors(p.params);
  if (errors.length) throw new Error(`Invalid protocol: ${errors.join('; ')}.`);
  return {
    format: 'barnes-maze-protocol', formatVersion: 1,
    name: p.name!.trim(), revision: p.revision!.trim(), params: structuredClone(p.params!),
  };
}
