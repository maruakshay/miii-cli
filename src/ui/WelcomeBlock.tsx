import { Box, Text } from 'ink'
import type { Effort } from '../config.js'
import { currentVersion } from '../updateCheck.js'
import { WELCOME_COMMANDS, WELCOME_PROMPT } from './constants.js'

// Lifecycle of the background self-update for the launch banner.
//   idle        — a newer release exists; auto-update off, on cooldown, or failed to start
//   downloading — install kicked off in the background
//   installed   — background install finished; applies on next launch
//   failed      — background install exited non-zero
export type UpdateStatus = 'idle' | 'downloading' | 'installed' | 'failed'

// Single source of truth for the update banner copy, shared by the welcome
// header and the in-chat banner so they never drift.
export function updateBannerText(version: string, status: UpdateStatus): string {
  switch (status) {
    case 'downloading':
      return `↑ v${version} downloading in the background — restart miii to apply`
    case 'installed':
      return `✓ v${version} installed — restart miii to apply`
    case 'failed':
      return `↑ v${version} update failed — run \`miii update\` manually`
    default:
      return `↑ v${version} available — run \`miii update\` to upgrade`
  }
}

/** The `>_` prompt mark that brands every miii surface. */
const MARK = '>_'

interface Props {
  model: string | undefined
  activeCtx: number | null
  effort: Effort
  cwd: string
  provider?: string
  error?: string | null
  updateAvailable?: string | null
  updateStatus?: UpdateStatus
  /**
   * 'full'    — the launch card: identity, session facts, and how to start.
   *             Printed once into the chat scrollback, Codex-style.
   * 'compact' — a two-line status strip, for screens that carry their own body
   *             (model picker, provider picker, connecting…).
   */
  variant?: 'full' | 'compact'
}

/** model · ctx · effort · provider — the session facts, in one dim row. */
function statusParts(
  model: string | undefined,
  activeCtx: number | null,
  effort: Effort,
  provider?: string,
): string[] {
  return [
    model ?? 'no model — /models',
    activeCtx != null ? `${Math.round(activeCtx / 1024)}k ctx` : '— ctx',
    `${effort} effort`,
    ...(provider ? [provider] : []),
  ]
}

/**
 * Dot-separated status row. Built as one string rather than a <Box gap> of
 * <Text>s so it wraps as a unit on a narrow terminal instead of laying the
 * separators out as flex children.
 */
function StatusRow({ parts }: { parts: string[] }) {
  return <Text dimColor>{parts.join('  ·  ')}</Text>
}

export function WelcomeBlock({
  model,
  activeCtx,
  effort,
  cwd,
  provider,
  updateAvailable,
  updateStatus = 'idle',
  variant = 'full',
}: Props) {
  const version = currentVersion()
  const parts = statusParts(model, activeCtx, effort, provider)
  const updateColor =
    updateStatus === 'failed' ? 'red' : updateStatus === 'installed' ? 'green' : 'yellow'

  if (variant === 'compact') {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box
          flexDirection="column"
          width="100%"
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
        >
          <Text>
            <Text color="blue" bold>{MARK} miii</Text>
            <Text dimColor>{version ? `  v${version}` : ''}</Text>
          </Text>
          <StatusRow parts={parts} />
          <Text dimColor>{cwd}</Text>
        </Box>
        {updateAvailable && (
          <Text color={updateColor}>{updateBannerText(updateAvailable, updateStatus)}</Text>
        )}
      </Box>
    )
  }

  // Command names are padded to a common width so the descriptions line up in a
  // column — the list reads as a table rather than ragged prose. The 0 floor
  // keeps Math.max from returning -Infinity if the featured list ever resolves
  // empty (a name renamed in COMMANDS but not in WELCOME_COMMAND_NAMES).
  const nameWidth = Math.max(0, ...WELCOME_COMMANDS.map((c) => c.name.length))

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={1}>
        <Text>
          <Text color="blue" bold>{MARK} miii</Text>
          <Text dimColor>{version ? `  v${version}` : ''}</Text>
        </Text>
      </Box>

      <Box
        flexDirection="column"
        width="100%"
        borderStyle="round"
        borderColor="gray"
        paddingX={2}
      >
        {/* One <Text> with nested styling, not sibling <Text>s in a row Box:
            siblings are separate flex children and each wraps on its own, which
            shreds the sentence on a narrow terminal. Nested <Text> is inline. */}
        <Text>
          <Text color="blue">{MARK}</Text> You are using <Text bold>miii</Text> in{' '}
          <Text bold>{cwd}</Text>
        </Text>

        <StatusRow parts={parts} />

        <Box marginTop={1}>
          <Text dimColor>{WELCOME_PROMPT}</Text>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          {WELCOME_COMMANDS.map((cmd) => (
            // Padding inside a single <Text> keeps the two columns aligned while
            // still wrapping as one unit — a row Box would wrap the command name
            // itself once the terminal gets narrow.
            <Text key={cmd.name}>
              <Text color="blue">{cmd.name.padEnd(nameWidth)}</Text>
              {'  '}
              <Text dimColor>{cmd.description}</Text>
            </Text>
          ))}
        </Box>
      </Box>

      {updateAvailable && (
        <Text color={updateColor}>{updateBannerText(updateAvailable, updateStatus)}</Text>
      )}
    </Box>
  )
}
