/**
 * Read an image off the OS clipboard, returned as base64 (no data: prefix).
 *
 * The terminal never hands binary clipboard data to stdin — Cmd+V only pastes
 * clipboard *text*. To attach a copied screenshot we shell out to a per-platform
 * clipboard reader. Returns null when there is no image on the clipboard (or no
 * reader is available), so the caller can show a notice instead of erroring.
 */
import { execFileSync } from 'child_process'
import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function safeRm(p: string): void {
  try { rmSync(p, { force: true }) } catch { /* ignore */ }
}

/** Read the temp PNG as base64, then delete it. */
function consume(p: string): string | null {
  try {
    const b64 = readFileSync(p).toString('base64')
    return b64.length > 0 ? b64 : null
  } catch {
    return null
  } finally {
    safeRm(p)
  }
}

function readMac(out: string): string | null {
  // pngpaste is fast and clean, but optional (brew install pngpaste).
  try {
    execFileSync('pngpaste', [out], { stdio: 'ignore' })
    if (existsSync(out)) return consume(out)
  } catch { /* pngpaste missing or clipboard has no image */ }

  // Fallback: AppleScript coerces the clipboard to PNG and writes it to `out`.
  // The coercion throws when there is no image → caught, returns "NOIMG".
  const png = '«class PNGf»' // «class PNGf»
  const script = [
    'try',
    `set f to open for access (POSIX file "${out}") with write permission`,
    `set theData to (the clipboard as ${png})`,
    'write theData to f',
    'close access f',
    'on error',
    'try',
    'close access f',
    'end try',
    'return "NOIMG"',
    'end try',
  ]
  try {
    const res = execFileSync('osascript', script.flatMap((s) => ['-e', s]), { encoding: 'utf8' })
    if (res.includes('NOIMG')) { safeRm(out); return null }
    if (existsSync(out)) return consume(out)
  } catch { /* osascript failed */ }
  safeRm(out)
  return null
}

function readLinux(out: string): string | null {
  // Wayland first, then X11. Both write the PNG to stdout; redirect to file.
  for (const [cmd, args] of [
    ['wl-paste', ['--type', 'image/png']],
    ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']],
  ] as const) {
    try {
      const buf = execFileSync(cmd, args, { maxBuffer: 64 * 1024 * 1024 })
      if (buf.length > 0) return buf.toString('base64')
    } catch { /* tool missing or no image */ }
  }
  return null
}

function readWindows(out: string): string | null {
  // PowerShell pulls the clipboard image via WinForms and saves it as PNG.
  // GetImage() returns $null when the clipboard holds no image → "NOIMG".
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
    '$img = [System.Windows.Forms.Clipboard]::GetImage();',
    // Single-quoted PS string → backslashes are literal, no escaping needed.
    `if ($img -ne $null) { $img.Save('${out}', [System.Drawing.Imaging.ImageFormat]::Png); 'OK' } else { 'NOIMG' }`,
  ].join(' ')
  try {
    const res = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', ps],
      { encoding: 'utf8' },
    )
    if (res.includes('NOIMG')) { safeRm(out); return null }
    if (existsSync(out)) return consume(out)
  } catch { /* powershell missing or no image */ }
  safeRm(out)
  return null
}

export function readClipboardImage(): string | null {
  const out = join(tmpdir(), `miii-clip-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
  if (process.platform === 'darwin') return readMac(out)
  if (process.platform === 'linux') return readLinux(out)
  if (process.platform === 'win32') return readWindows(out)
  return null
}
