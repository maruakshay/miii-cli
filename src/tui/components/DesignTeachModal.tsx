import { Box, Text } from 'ink'

export const DESIGN_TEACH_QUESTIONS = [
  'What does your product do? (one sentence)',
  'Who are your primary users? (e.g. developers, consumers, small teams, enterprises)',
  'How should it feel? List 3–5 words (e.g. bold, calm, precise, playful, minimal, trustworthy)',
  'Any existing brand colors? (hex codes — or "none" to start fresh)',
  'Any existing fonts? (font names — or "none" to choose new ones)',
  'Interface type? (dashboard / marketing / app / docs / landing page / other)',
  'Products or brands you want to look DIFFERENT from? (or "none")',
]

interface Props {
  question: string
  index: number
  total: number
}

export function DesignTeachModal({ question, index, total }: Props) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box gap={1}>
        <Text color="cyan" bold>◆ design setup</Text>
        <Text color="gray" dimColor>{index + 1} of {total}</Text>
      </Box>
      <Text color="white">{question}</Text>
    </Box>
  )
}

export function buildDesignPrompt(questions: string[], answers: string[], exists: boolean): string {
  const brief = questions.map((q, i) => `${q}\n→ ${answers[i] ?? '(skipped)'}`).join('\n\n')

  const fileInstruction = exists
    ? `DESIGN.md already exists. First call read_file on DESIGN.md to get the current content, then call update_file to replace the entire content with the updated design system (use the full current file as the <old> block).`
    : `Write DESIGN.md to the project root using the create_file tool.`

  return `You are an expert UI/UX designer following impeccable design principles. ${exists ? 'Update' : 'Create'} DESIGN.md based on this product brief.

Product Brief:
${brief}

Impeccable design philosophy (apply strictly):
- Typography: choose purposeful, distinctive fonts — avoid Inter/Roboto/generic defaults. Use modular scale. Consider display fonts for headings if brand personality supports it.
- Color: OKLCH-based system, tint neutrals with primary hue, minimum 4.5:1 contrast. No generic gray-on-white. Define primary, secondary, accent, 5 neutral steps, semantic colors (success/warning/error/info).
- Spatial: 4px-base spacing scale, clear hierarchy through deliberate whitespace.
- Motion: cubic-bezier curves (not linear/ease), respect prefers-reduced-motion.
- Interaction: always-visible focus states, meaningful hover/active transitions.
- Anti-patterns to eliminate: nested card shadows, purple-to-blue gradients, Inter everywhere, insufficient contrast, centered walls of text, auto-playing anything, generic SaaS aesthetics.

${exists ? 'Update' : 'Create'} DESIGN.md with ALL these sections:

## Product
[2-3 sentences: what it is, who uses it, core value]

## Brand Voice
[5 personality adjectives + 1 sentence on visual tone]

## Colors
Full OKLCH color system with hex equivalents:
- Primary: oklch(...) / #... [usage: CTAs, links, key actions]
- Secondary: oklch(...) / #...
- Accent: oklch(...) / #...
- Neutral-50 through Neutral-900 (tinted with primary hue)
- Success / Warning / Error / Info
Rationale: why these colors fit the brand personality.

## Typography
Heading font: [specific name] — why it fits this brand
Body font: [specific name] — why it fits
Scale:
- 3xl: 2.5rem / 700 — hero headings
- 2xl: 2rem / 600 — section headings
- xl: 1.5rem / 600 — card titles
- lg: 1.125rem / 500 — subheadings
- base: 1rem / 400 — body text
- sm: 0.875rem / 400 — captions, labels
- xs: 0.75rem / 400 — metadata

## Spacing
Token scale (4px base):
space-1: 4px | space-2: 8px | space-3: 12px | space-4: 16px
space-6: 24px | space-8: 32px | space-12: 48px | space-16: 64px | space-24: 96px

## Components
- Border-radius approach and why (sharp/medium/large/pill)
- Shadow style (none/subtle/elevated/dramatic)
- Button: primary, secondary, ghost — hover/active/focus/disabled states
- Input: default, focus, error, disabled states
- Card: background, border, shadow, padding
- Navigation: desktop + mobile pattern

## Motion
- Durations: fast 100ms / base 200ms / slow 350ms
- Easing: cubic-bezier(0.4, 0, 0.2, 1) standard, cubic-bezier(0, 0, 0.2, 1) decelerate
- Use cases: button click, hover transitions, modal open, page change

## Anti-patterns
8–10 specific things NOT to do for THIS product (derive from brand personality + interface type, not generic advice)

## Design Principles
4 guiding principles specific to this product — not generic platitudes

Be specific, opinionated, brand-appropriate. Every choice needs a reason. No placeholder text.
${fileInstruction}`
}
