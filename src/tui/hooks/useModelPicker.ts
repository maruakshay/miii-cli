import { useState, useRef, useCallback, useEffect } from 'react'
import type { Config } from '../../types.js'
import type { OllamaModel } from '../../llm/ollama.js'
import { listModels, pullModel } from '../../llm/ollama.js'
import * as printer from '../printer.js'

export function useModelPicker(config: Config) {
  const [currentModel, setCurrentModel] = useState(config.model)
  const currentModelRef = useRef(config.model)
  const [pickerOpen, setPickerOpen] = useState(true)
  const [pickerModels, setPickerModels] = useState<OllamaModel[]>([])
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerError, setPickerError] = useState<string | undefined>()
  const [pullState, setPullState] = useState<{ name: string; status: string; pct: number | undefined } | undefined>()
  const pullAbortRef = useRef<AbortController | null>(null)

  useEffect(() => { currentModelRef.current = currentModel }, [currentModel])

  useEffect(() => {
    setPickerLoading(true)
    listModels(config.baseUrl)
      .then(m => { setPickerModels(m); setPickerLoading(false) })
      .catch(e => { setPickerError(String(e)); setPickerLoading(false) })
  }, [])

  const openPicker = useCallback(async () => {
    setPickerOpen(true)
    setPickerLoading(true)
    setPickerError(undefined)
    try { setPickerModels(await listModels(config.baseUrl)) }
    catch (e) { setPickerError(String(e)) }
    finally { setPickerLoading(false) }
  }, [config.baseUrl])

  const handleModelSelect = useCallback((name: string) => {
    setCurrentModel(name)
    currentModelRef.current = name
    setPickerOpen(false)
    printer.systemMsg(`model → ${name}`)
  }, [])

  const handleModelPull = useCallback(async (name: string) => {
    setPullState({ name, status: 'starting...', pct: undefined })
    pullAbortRef.current = new AbortController()
    try {
      await pullModel(config.baseUrl, name, (s, p) => setPullState({ name, status: s, pct: p }), pullAbortRef.current.signal)
      setPickerModels(await listModels(config.baseUrl))
      setPullState(undefined)
      setCurrentModel(name)
      currentModelRef.current = name
      setPickerOpen(false)
      printer.systemMsg(`pulled ${name} → active`)
    } catch (e) {
      setPullState(undefined)
      setPickerError(`pull failed: ${e}`)
    }
  }, [config.baseUrl])

  return {
    currentModel, setCurrentModel, currentModelRef,
    pickerOpen, setPickerOpen,
    pickerModels, pickerLoading, pickerError, pullState,
    openPicker, handleModelSelect, handleModelPull,
  }
}
