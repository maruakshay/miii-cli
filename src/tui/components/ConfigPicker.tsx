import React, { useState, useEffect } from 'react'
import { Box, Text, useInput } from 'ink'
import type { Config } from '../../types.js'

type Screen = 'menu' | 'provider' | 'model' | 'key' | 'url' | 'tavily'
type MenuItem = Screen | 'streaming'

interface Props {
  config: Config
  currentModel: string
  tavilyKey?: string
  onUpdate: (patch: Partial<Config> & { model?: string }) => void
  onTavilyKey: (key: string) => void
  onClose: () => void
}

const PROVIDERS: Array<{ key: Config['provider']; label: string; desc: string }> = [
  { key: 'ollama',        label: 'Ollama',          desc: 'local · free · air-gapped'       },
  { key: 'anthropic',     label: 'Anthropic',       desc: 'Claude API (cloud)'               },
  { key: 'openai-compat', label: 'OpenAI / Custom', desc: 'OpenAI or compatible endpoint'   },
]

const MENU_ITEMS: Array<{ key: MenuItem; label: string }> = [
  { key: 'provider',  label: 'Provider'  },
  { key: 'model',     label: 'Model'     },
  { key: 'key',       label: 'API Key'   },
  { key: 'url',       label: 'Base URL'  },
  { key: 'tavily',    label: 'Tavily Key'},
  { key: 'streaming', label: 'Streaming' },
]

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + '…' : s
}

export function ConfigPicker({ config, currentModel, tavilyKey, onUpdate, onTavilyKey, onClose }: Props) {
  const [screen, setScreen] = useState<Screen>('menu')
  const [menuIdx, setMenuIdx] = useState(0)
  const [provIdx, setProvIdx] = useState(
    () => PROVIDERS.findIndex(p => p.key === config.provider) ?? 0
  )
  const [textInput, setTextInput] = useState('')
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [modelIdx, setModelIdx] = useState(0)

  // Reset models list when provider changes so stale ollama models don't show
  useEffect(() => { setOllamaModels([]) }, [config.provider])

  // Fetch Ollama models when entering model screen on ollama provider
  useEffect(() => {
    if (screen !== 'model' || config.provider !== 'ollama') return
    if (!config.baseUrl) return
    setOllamaModels([])
    fetch(`${config.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) })
      .then(r => r.json())
      .then((d: { models?: Array<{ name: string }> }) => {
        const names = (d.models ?? []).map(m => m.name).filter(Boolean)
        if (names.length) {
          setOllamaModels(names)
          const ci = names.indexOf(currentModel)
          setModelIdx(ci >= 0 ? ci : 0)
        }
      })
      .catch(() => {})
  }, [screen, config.provider, config.baseUrl])

  function goMenu() { setScreen('menu'); setTextInput('') }

  function openScreen(s: Screen) {
    if (s === 'key')    setTextInput(config.apiKey ?? '')
    if (s === 'url')    setTextInput(config.baseUrl)
    if (s === 'tavily') setTextInput(tavilyKey ?? '')
    if (s === 'model' && config.provider !== 'ollama') setTextInput(currentModel)
    setScreen(s)
  }

  useInput((input, key) => {
    if (key.escape) {
      if (screen !== 'menu') { goMenu(); return }
      onClose(); return
    }

    // ── Menu ────────────────────────────────────────────────────────────────
    if (screen === 'menu') {
      if (key.upArrow)   { setMenuIdx(i => Math.max(0, i - 1)); return }
      if (key.downArrow) { setMenuIdx(i => Math.min(MENU_ITEMS.length - 1, i + 1)); return }
      if (key.return) {
        const item = MENU_ITEMS[menuIdx]
        if (item.key === 'streaming') { onUpdate({ streaming: !config.streaming }); return }
        openScreen(item.key as Screen)
        return
      }
      return
    }

    // ── Provider radio ───────────────────────────────────────────────────────
    if (screen === 'provider') {
      if (key.upArrow)   { setProvIdx(i => Math.max(0, i - 1)); return }
      if (key.downArrow) { setProvIdx(i => Math.min(PROVIDERS.length - 1, i + 1)); return }
      if (key.return) {
        onUpdate({ provider: PROVIDERS[provIdx].key })
        goMenu(); return
      }
      return
    }

    // ── Ollama model list ────────────────────────────────────────────────────
    if (screen === 'model' && config.provider === 'ollama' && ollamaModels.length) {
      if (key.upArrow)   { setModelIdx(i => Math.max(0, i - 1)); return }
      if (key.downArrow) { setModelIdx(i => Math.min(ollamaModels.length - 1, i + 1)); return }
      if (key.return) {
        onUpdate({ model: ollamaModels[modelIdx] })
        goMenu(); return
      }
      return
    }

    // ── Text input (model for cloud, key, url) ───────────────────────────────
    if (key.return) {
      const val = textInput.trim()
      if (!val) { goMenu(); return }
      if (screen === 'model')  onUpdate({ model: val })
      if (screen === 'key')    onUpdate({ apiKey: val })
      if (screen === 'url')    onUpdate({ baseUrl: val })
      if (screen === 'tavily') onTavilyKey(val)
      goMenu(); return
    }
    if (key.backspace || key.delete) { setTextInput(t => t.slice(0, -1)); return }
    if (input && !key.ctrl && !key.meta) { setTextInput(t => t + input); return }
  })

  const keyDisplay = config.apiKey
    ? `${config.apiKey.slice(0, 10)}…`
    : 'not set'
  const tavilyDisplay = tavilyKey
    ? `${tavilyKey.slice(0, 10)}…`
    : 'not set'

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan"> config </Text>
        {screen !== 'menu' && (
          <Text color="gray" dimColor> › {screen}  esc back</Text>
        )}
      </Box>

      {/* ── Menu ──────────────────────────────────────────────────────────── */}
      {screen === 'menu' && MENU_ITEMS.map((item, i) => {
        const active = i === menuIdx
        let val = ''
        if (item.key === 'provider')  val = config.provider
        if (item.key === 'model')     val = truncate(currentModel, 32)
        if (item.key === 'key')       val = keyDisplay
        if (item.key === 'url')       val = truncate(config.baseUrl, 36)
        if (item.key === 'tavily')    val = tavilyDisplay
        const isStreaming = item.key === 'streaming'
        const streamingOn = config.streaming === true
        return (
          <Box key={item.key}>
            <Text color={active ? 'cyan' : 'white'} bold={active}>
              {active ? '▶ ' : '  '}
              {item.label.padEnd(12)}
            </Text>
            {isStreaming
              ? <Text color={streamingOn ? 'green' : 'gray'}>{streamingOn ? 'on' : 'off'}</Text>
              : <Text color={active ? 'white' : 'gray'}>{val}</Text>
            }
          </Box>
        )
      })}

      {/* ── Provider radio ────────────────────────────────────────────────── */}
      {screen === 'provider' && PROVIDERS.map((p, i) => {
        const active = i === provIdx
        const current = p.key === config.provider
        return (
          <Box key={p.key} gap={1}>
            <Text color={active ? 'cyan' : 'gray'}>
              {active ? '▶ ' : '  '}{current ? '◉' : '○'}
            </Text>
            <Text color={active ? 'white' : 'gray'} bold={active}>
              {p.label.padEnd(18)}
            </Text>
            <Text color="gray" dimColor>{p.desc}</Text>
          </Box>
        )
      })}

      {/* ── Ollama model list ─────────────────────────────────────────────── */}
      {screen === 'model' && config.provider === 'ollama' && (
        ollamaModels.length ? (
          ollamaModels.map((name, i) => {
            const active = i === modelIdx
            const isCurrent = name === currentModel
            return (
              <Box key={name} gap={1}>
                <Text color={active ? 'cyan' : 'gray'}>{active ? '▶ ' : '  '}</Text>
                <Text color={active ? 'white' : 'gray'} bold={active}>{name}</Text>
                {isCurrent && <Text color="green"> ✓</Text>}
              </Box>
            )
          })
        ) : (
          <Box flexDirection="column" gap={1}>
            <Text color="gray" dimColor>fetching from Ollama…</Text>
            <Box gap={1}>
              <Text color="cyan">model name: </Text>
              <Text>{textInput}█</Text>
            </Box>
          </Box>
        )
      )}

      {/* ── Text input (cloud model / key / url) ──────────────────────────── */}
      {(screen === 'key' || screen === 'url' || screen === 'tavily' || (screen === 'model' && config.provider !== 'ollama')) && (
        <Box flexDirection="column">
          <Box gap={1}>
            <Text color="cyan">{screen === 'key' ? 'api key' : screen === 'url' ? 'url' : screen === 'tavily' ? 'tavily key' : 'model'}: </Text>
            <Text>{textInput}█</Text>
          </Box>
          <Text color="gray" dimColor>enter to save  esc to cancel</Text>
        </Box>
      )}

      <Box marginTop={1} borderTop borderStyle="single" borderColor="gray">
        <Text color="gray" dimColor>
          {screen === 'menu'
            ? '↑↓ navigate  enter edit  esc close'
            : screen === 'provider' || (screen === 'model' && ollamaModels.length > 0)
            ? '↑↓ select  enter confirm  esc back'
            : 'type value  enter save  esc back'}
        </Text>
      </Box>
    </Box>
  )
}
