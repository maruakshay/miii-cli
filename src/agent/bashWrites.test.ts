import { describe, it, expect } from 'vitest'
import { bashWriteTargets, stripHeredocs } from './bashWrites.js'

describe('stripHeredocs', () => {
  it('drops the body so code inside it is not read as shell', () => {
    const cmd = "cat > a.ts <<'EOF'\nif (a > b) run()\nEOF\necho done"
    const out = stripHeredocs(cmd)
    expect(out).not.toContain('if (a > b)')
    expect(out).toContain("cat > a.ts <<'EOF'")
    expect(out).toContain('echo done')
  })

  it('handles two heredocs on one line', () => {
    const cmd = "cmd <<'A' <<'B'\nbody a\nA\nbody b\nB\ntail"
    expect(stripHeredocs(cmd)).toBe("cmd <<'A' <<'B'\ntail")
  })
})

describe('bashWriteTargets', () => {
  it('finds a truncating redirect', () => {
    expect(bashWriteTargets('echo hi > out.txt')).toEqual(['out.txt'])
  })

  it('finds the target of a heredoc write', () => {
    expect(bashWriteTargets("cat > src/a.ts <<'EOF'\nbody\nEOF")).toEqual(['src/a.ts'])
  })

  it('ignores appends', () => {
    expect(bashWriteTargets('echo hi >> log.txt')).toEqual([])
  })

  it('ignores fd duplication but catches a redirected fd', () => {
    expect(bashWriteTargets('cmd 2>&1')).toEqual([])
    expect(bashWriteTargets('cmd 2> err.log')).toEqual(['err.log'])
  })

  it('does not treat a quoted angle bracket as a redirect', () => {
    expect(bashWriteTargets(`grep "a > b" src/`)).toEqual([])
    expect(bashWriteTargets(`rg '=>' src/`)).toEqual([])
  })

  it('catches sed -i on both BSD and GNU spellings', () => {
    expect(bashWriteTargets("sed -i '' 's/a/b/' src/x.ts")).toContain('src/x.ts')
    expect(bashWriteTargets("sed -i 's/a/b/' src/x.ts")).toContain('src/x.ts')
  })

  it('leaves sed alone without -i', () => {
    expect(bashWriteTargets("sed 's/a/b/' src/x.ts")).toEqual([])
  })

  it('catches tee but not tee -a', () => {
    expect(bashWriteTargets('echo x | tee out.txt')).toEqual(['out.txt'])
    expect(bashWriteTargets('echo x | tee -a out.txt')).toEqual([])
  })

  it('finds targets across chained commands', () => {
    const t = bashWriteTargets('npm run build && cat > dist/a.js <<EOF\nx\nEOF\nrm -rf tmp')
    expect(t).toEqual(['dist/a.js'])
  })

  it('reports nothing for ordinary read-only commands', () => {
    expect(bashWriteTargets('npx vitest run')).toEqual([])
    expect(bashWriteTargets('git status --short | head -30')).toEqual([])
    expect(bashWriteTargets('cat src/a.ts')).toEqual([])
  })
})
