/**
 * A frozen task the agent must accomplish. Deliberately tiny and declarative:
 * fixture files in, prompt in, a boolean (or failure-reason string) out.
 *
 * `check` runs AFTER the agent finishes, against the scenario's temp working
 * directory. Return true to pass, or a string explaining the failure. Read the
 * real files the agent touched — assert on outcomes, never on the agent's prose.
 */
export interface Scenario {
  name: string
  prompt: string
  /** path (relative to temp cwd) -> initial file content. Dirs auto-created. */
  files?: Record<string, string>
  /**
   * Outcome assertion. true = pass; string = fail reason.
   * `finalText` is the agent's last plain-text answer — assert on it for
   * locate/read tasks so a no-op run cannot false-pass.
   */
  check: (dir: string, finalText: string) => boolean | string | Promise<boolean | string>
  /**
   * Turn budget. A scenario that passes in 3 calls today and 11 tomorrow has
   * regressed even though it still passes — the harness stopped steering and
   * started letting the model flail. Set it generously (roughly double a good
   * run) so it catches flailing, not model-to-model variance.
   */
  maxToolCalls?: number
}

export interface Result {
  name: string
  pass: boolean
  reason?: string          // failure detail when !pass
  toolCalls: number        // proxy for "how many turns / how much work"
  /**
   * How many malformed things the harness silently fixed this run (names,
   * argument keys, types, envelopes). Not a failure — a repaired call runs —
   * but it is the measurement that tells you which repairs earn their keep and
   * which models need them, instead of guessing at the alias tables.
   */
  repairs: number
  /** Repairs bucketed by kind: name / key / type / envelope. */
  repairDetail: Record<string, number>
  promptTokens: number
  evalTokens: number
  durationMs: number
  error?: string           // loop-level error (repetition kill, stream fail…)
}
