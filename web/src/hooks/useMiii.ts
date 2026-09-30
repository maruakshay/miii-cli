import { useEffect, useReducer, useRef, useState } from 'react'
import { events } from '@/lib/api'
import type { Command, Hello, ModeInfo, SessionMeta, WebMessage, WebState } from '@/lib/types'

interface Store {
  ready: boolean
  state: WebState | null
  messages: WebMessage[]
  sessions: SessionMeta[]
  commands: Command[]
  modes: ModeInfo[]
}

type Action =
  | { type: 'hello'; hello: Hello }
  | { type: 'state'; state: WebState }
  | { type: 'message'; message: WebMessage }
  | { type: 'messages'; messages: WebMessage[] }
  | { type: 'sessions'; sessions: SessionMeta[] }

function reduce(s: Store, a: Action): Store {
  switch (a.type) {
    case 'hello':
      return { ready: true, ...a.hello }
    case 'state':
      return { ...s, state: a.state }
    case 'messages':
      return { ...s, messages: a.messages }
    case 'sessions':
      return { ...s, sessions: a.sessions }
    case 'message': {
      // The server owns the transcript; the browser only upserts by id.
      const i = s.messages.findIndex((m) => m.id === a.message.id)
      const messages = i === -1 ? [...s.messages, a.message] : s.messages.map((m, j) => (j === i ? a.message : m))
      return { ...s, messages }
    }
  }
}

const EMPTY: Store = { ready: false, state: null, messages: [], sessions: [], commands: [], modes: [] }

/** Live view of the agent. Reconnects on its own; each reconnect starts from a fresh `hello`. */
export function useMiii(onToast: (text: string) => void) {
  const [store, dispatch] = useReducer(reduce, EMPTY)
  const [connected, setConnected] = useState(false)
  const [unauthorized, setUnauthorized] = useState(false)
  const toastRef = useRef(onToast)
  toastRef.current = onToast

  useEffect(() => {
    const es = events()
    const on = <T,>(name: string, fn: (data: T) => void) =>
      es.addEventListener(name, (e) => fn(JSON.parse((e as MessageEvent).data) as T))
    on<Hello>('hello', (hello) => { setConnected(true); setUnauthorized(false); dispatch({ type: 'hello', hello }) })
    on<{ state: WebState }>('state', (d) => dispatch({ type: 'state', state: d.state }))
    on<{ message: WebMessage }>('message', (d) => dispatch({ type: 'message', message: d.message }))
    on<{ messages: WebMessage[] }>('messages', (d) => dispatch({ type: 'messages', messages: d.messages }))
    on<{ sessions: SessionMeta[] }>('sessions', (d) => dispatch({ type: 'sessions', sessions: d.sessions }))
    on<{ text: string }>('toast', (d) => toastRef.current(d.text))
    es.onerror = () => {
      setConnected(false)
      // A 401 closes the stream for good rather than retrying.
      if (es.readyState === EventSource.CLOSED) setUnauthorized(true)
    }
    return () => es.close()
  }, [])

  return { ...store, connected, unauthorized }
}
