export type Depth = 'quick' | 'standard' | 'deep';
export type ProviderName = 'claude-code' | 'demo';
export type SessionStatus = 'running' | 'awaiting_user' | 'done' | 'error' | 'cancelled' | 'interrupted';
export type Phase = 'intake' | 'opening' | 'debate' | 'ballot' | 'verdict' | 'done';
export type TurnKind = 'intake' | 'welcome' | 'opening' | 'moderate' | 'response' | 'ballot' | 'verdict' | 'founder';

export interface Advisor {
  id: string;
  role: 'advisor' | 'chair';
  name: string;
  /** First name or nickname used at the table ("Warren"). */
  short: string;
  title: string;
  initials: string;
  color: string;
  seat: number;
  /** One line describing how this advisor looks at a decision. */
  lens: string;
  /** Full persona prompt (markdown body of the advisor file). */
  persona: string;
}

export type AdvisorProfile = Omit<Advisor, 'persona'>;

export interface SessionInput {
  decision: string;
  context: string;
  advisors: string[];
  depth: Depth;
  model: string;
  provider: ProviderName;
}

export interface DecisionOption {
  id: string;
  label: string;
  description: string;
}

export interface Question {
  id: string;
  text: string;
  why: string;
}

export interface Intake {
  title: string;
  framing: string;
  options: DecisionOption[];
  questions: Question[];
  /** null until the founder answers (or skips) the chair's questions. */
  answers: Record<string, string> | null;
}

export interface Turn {
  id: string;
  speaker: string;
  kind: TurnKind;
  round?: number;
  text: string;
  meta?: Record<string, unknown>;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

/** A turn that is still being generated. Never persisted. */
export interface LiveTurn {
  id: string;
  speaker: string;
  kind: TurnKind;
  round?: number;
  text: string;
  startedAt: string;
}

export interface Round {
  index: number;
  moderatorTurnId: string;
  next: string[];
  askFounder: string | null;
  answered: boolean;
  founderAnswer: string | null;
}

export interface Ballot {
  advisorId: string;
  vote: string;
  conviction: number;
  reason: string;
  turnId: string;
}

export interface CriterionScore {
  id: string;
  score: number;
  why: string;
}

export interface OptionScore {
  optionId: string;
  criteria: CriterionScore[];
  total: number;
}

export interface Attributed {
  text: string;
  by: string;
}

export interface Risk {
  risk: string;
  mitigation: string;
}

export interface Verdict {
  recommendation: string;
  label: string;
  headline: string;
  confidence: 'low' | 'medium' | 'high';
  speech: string;
  /** Weighted 0-100 score of the recommended option. */
  score: number;
  scores: OptionScore[];
  tally: Record<string, number>;
  strongestFor: Attributed[];
  strongestAgainst: Attributed[];
  conditions: string[];
  risks: Risk[];
  nextSteps: string[];
  wouldChange: string[];
  dissent: string;
}

export interface Pending {
  type: 'intake' | 'chair';
  questions: Question[];
  round?: number;
}

export interface Session {
  id: string;
  version: 1;
  title: string;
  createdAt: string;
  updatedAt: string;
  input: SessionInput;
  /** Snapshot of the chair and seated advisors, so old sessions render even if advisor files change. */
  cast: AdvisorProfile[];
  status: SessionStatus;
  phase: Phase;
  error: string | null;
  intake: Intake | null;
  turns: Turn[];
  rounds: Round[];
  ballots: Ballot[];
  verdict: Verdict | null;
  pending: Pending | null;
  /** Founder interjections waiting for the current speaker to finish. */
  queue: string[];
  live: LiveTurn[];
  stats: { calls: number };
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  phase: Phase;
  provider: ProviderName;
  model: string;
  advisorCount: number;
  verdictLabel: string | null;
  score: number | null;
}
