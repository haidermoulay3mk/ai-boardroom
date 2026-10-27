import type { ProviderName, Session, TurnKind } from '../types.ts';

/** Context about the turn being generated. Real models ignore it; the demo provider scripts from it. */
export interface GenerateHint {
  kind: TurnKind | 'repair';
  speaker: string;
  round?: number;
  session: Session;
}

export interface GenerateOptions {
  prompt: string;
  model: string;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onStatus?: (message: string) => void;
  hint?: GenerateHint;
}

export interface GenerateResult {
  text: string;
}

export interface ProviderHealth {
  name: ProviderName;
  ready: boolean;
  detail: string;
  version?: string | null;
  loggedIn?: boolean | null;
  plan?: string | null;
  authMethod?: string | null;
}

export interface Provider {
  readonly name: ProviderName;
  generate(options: GenerateOptions): Promise<GenerateResult>;
  /** Start processes in advance so the next turn begins without a cold start. */
  prewarm(model: string, count?: number): void;
  health(): Promise<ProviderHealth>;
  dispose(): void;
}

export class ProviderError extends Error {
  override name = 'ProviderError';
}

export class AbortError extends Error {
  override name = 'AbortError';
  constructor() {
    super('Cancelled');
  }
}
