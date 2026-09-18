/**
 * Adding and removing providers by name.
 *
 * Shared by the `/provider add` slash command and the `miii provider` CLI so
 * both accept exactly the same arguments and produce the same messages.
 *
 * The whole point is that a name is usually enough: `/provider add anthropic`
 * looks the endpoint up in the preset table and reads the key from the
 * environment variable that provider already uses. A key can be passed instead,
 * and an unknown name is fine too as long as a base URL comes with it.
 */
import { addProvider, removeProvider, listProviders, apiKeyFor, type ProviderEntry } from '../config.js'
import { presetFor, presetNames, PRESETS } from './presets.js'

export interface Result {
  ok: boolean
  message: string
}

function looksLikeUrl(s: string): boolean {
  return /^https?:\/\//i.test(s)
}

/**
 * People copy the endpoint straight out of a provider's docs, which usually
 * already ends in /v1 — and the openai adapter appends /v1 itself. Trim the
 * trailing slash, and when the URL already points at the API root say so with
 * an empty apiPath instead of silently building /v1/v1/chat/completions.
 */
function splitBase(raw: string): { baseUrl: string; apiPath?: string } {
  const baseUrl = raw.replace(/\/+$/, '')
  return /\/v\d+(?:beta|alpha)?$/i.test(baseUrl) ? { baseUrl, apiPath: '' } : { baseUrl }
}

/**
 * `add <name> [baseUrl] [apiKey]` — the two optional arguments are positional
 * but distinguishable: anything starting with http(s):// is the URL, anything
 * else is the key. That way all of these work:
 *
 *   add anthropic                      preset + $ANTHROPIC_API_KEY
 *   add anthropic sk-ant-…             preset + an explicit key
 *   add mycorp https://llm.corp/v1     custom OpenAI-compatible endpoint
 *   add mycorp https://llm.corp/v1 k   …with a key
 */
export function addByName(args: string[]): Result {
  const [name, ...rest] = args
  if (!name) {
    return { ok: false, message: `usage: provider add <name> [baseUrl] [apiKey] — known: ${presetNames().join(', ')}` }
  }

  const baseUrl = rest.find(looksLikeUrl)
  const apiKey = rest.find((a) => !looksLikeUrl(a))
  const preset = presetFor(name)

  if (!preset && !baseUrl) {
    return {
      ok: false,
      message:
        `I don't know a provider called "${name}". Pass its endpoint to add it anyway:\n` +
        `  provider add ${name} https://host/v1 <apiKey>\n` +
        `Known names: ${presetNames().join(', ')}`,
    }
  }

  // An explicit URL overrides the preset's, and then it owns the path too.
  const custom = baseUrl ? splitBase(baseUrl) : undefined
  const entry: ProviderEntry = preset
    ? {
        type: preset.type,
        baseUrl: custom?.baseUrl ?? preset.baseUrl,
        ...(custom ? (custom.apiPath !== undefined ? { apiPath: custom.apiPath } : {})
                   : (preset.apiPath !== undefined ? { apiPath: preset.apiPath } : {})),
        ...(preset.apiKeyEnv ? { apiKeyEnv: preset.apiKeyEnv } : {}),
        ...(preset.contextWindow ? { contextWindow: preset.contextWindow } : {}),
        ...(apiKey ? { apiKey } : {}),
      }
    : // No preset: assume the near-universal OpenAI-compatible wire format.
      { type: 'openai', ...custom!, ...(apiKey ? { apiKey } : {}) }

  addProvider(name, entry)

  const keyed = Boolean(apiKeyFor(entry))
  const where = apiKey ? 'key saved to ~/.miii/config.json' : entry.apiKeyEnv ? `key from $${entry.apiKeyEnv}` : 'no key'
  const warn =
    !keyed && entry.apiKeyEnv
      ? `\n$${entry.apiKeyEnv} isn't set — export it, or re-run with the key: provider add ${name} <apiKey>`
      : ''

  const model = preset?.defaultModel ? ` — try /models, e.g. ${preset.defaultModel}` : ''
  return { ok: true, message: `added ${name} (${entry.baseUrl}, ${where}) and switched to it${model}${warn}` }
}

export function removeByName(name: string): Result {
  if (!name) return { ok: false, message: 'usage: provider remove <name>' }
  if (!removeProvider(name)) {
    return {
      ok: false,
      message: listProviders().includes(name)
        ? `"${name}" is a built-in provider, so there's nothing to remove.`
        : `no provider called "${name}".`,
    }
  }
  return { ok: true, message: `removed ${name}` }
}

/** The preset table, for `miii provider list --all` and the picker's footer. */
export function describePresets(): string {
  const width = Math.max(...presetNames().map((n) => n.length))
  return Object.entries(PRESETS)
    .map(([name, p]) => `  ${name.padEnd(width)}  ${p.label.padEnd(22)} ${p.apiKeyEnv ? `$${p.apiKeyEnv}` : 'no key needed'}`)
    .join('\n')
}
