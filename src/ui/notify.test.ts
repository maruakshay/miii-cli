import { describe, expect, it } from 'vitest'
import { notifySequence } from './notify.js'

describe('notifySequence', () => {
  it('rings the bell everywhere', () => {
    expect(notifySequence('Done', { TERM_PROGRAM: 'Apple_Terminal' })).toBe('\x07')
    expect(notifySequence('Done', {})).toBe('\x07')
  })

  it('adds a desktop notification where the terminal shows one', () => {
    expect(notifySequence('Done', { TERM_PROGRAM: 'iTerm.app' })).toBe('\x1b]9;miii — Done\x07\x07')
  })

  it('cannot be used to smuggle escapes', () => {
    expect(notifySequence('a\x1b]2;x\x07b', { TERM_PROGRAM: 'ghostty' })).toBe('\x1b]9;miii — a ]2;x b\x07\x07')
  })
})
