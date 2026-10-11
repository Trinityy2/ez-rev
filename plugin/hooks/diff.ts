import type { DiffLine, Note } from '../types'

const CODE_LIMIT = 9500

/** Parses a single-file unified diff into lines, numbering each against both sides. */
export function parseDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = []
  let oldBefore = 0
  let newBefore = 0
  let isInHunk = false

  for (const raw of diff.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) {
      isInHunk = true
      oldBefore = Math.max(0, Number(hunk[1]) - 1)
      newBefore = Math.max(0, Number(hunk[2]) - 1)
      continue
    }
    if (!isInHunk || raw.startsWith('\\')) continue

    const kind = raw[0]
    if (kind !== ' ' && kind !== '+' && kind !== '-') continue
    lines.push({ kind, text: raw.slice(1), oldBefore, newBefore })
    if (kind !== '+') oldBefore += 1
    if (kind !== '-') newBefore += 1
  }

  return lines
}

/** Every line of a file as unchanged (`' '`) or new (`'+'`). */
export function plainLines(text: string, kind: ' ' | '+'): DiffLine[] {
  const rows = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')

  return rows.map((row, i) => ({
    kind,
    text: row,
    oldBefore: kind === ' ' ? i : 0,
    newBefore: i,
  }))
}

/** The new-file line number of a line, or undefined for a removed one. */
export function newNumber(line: DiffLine): number | undefined {
  return line.kind === '-' ? undefined : line.newBefore + 1
}

/** Keeps the lines between `start` and `end` of the new file, removals inside that span included. */
export function sliceRange(lines: DiffLine[], start: number, end: number): DiffLine[] {
  return lines.filter(line =>
    line.kind === '-'
      ? line.newBefore >= start - 1 && line.newBefore < end
      : line.newBefore + 1 >= start && line.newBefore + 1 <= end,
  )
}

export type Segment =
  | { type: 'code'; lines: DiffLine[] }
  | { type: 'line'; line: DiffLine; number: number; notes: Note[] }

/** Splits a chunk's lines around every annotated line, which stands alone so it can carry its notes. */
export function segment(lines: DiffLine[], notes: Note[]): Segment[] {
  const byLine = new Map<number, Note[]>()
  for (const note of notes) {
    byLine.set(note.line, [...(byLine.get(note.line) ?? []), note])
  }

  const out: Segment[] = []
  let current: DiffLine[] = []
  for (const line of lines) {
    const n = newNumber(line)
    const here = n === undefined ? undefined : byLine.get(n)
    if (here) {
      if (current.length > 0) out.push({ type: 'code', lines: current })
      out.push({ type: 'line', line, number: n!, notes: here })
      current = []
    } else {
      current.push(line)
    }
  }
  if (current.length > 0) out.push({ type: 'code', lines: current })

  return out
}

/** The notes no line of the chunk carries. */
export function strayNotes(lines: DiffLine[], notes: Note[]): Note[] {
  const shown = new Set(lines.map(newNumber).filter(n => n !== undefined))

  return notes.filter(note => !shown.has(note.line))
}

/** A unified-diff hunk for `Code format="diff"`, its header counted from the lines. */
export function toHunk(lines: DiffLine[]): string {
  const first = lines[0]!
  const oldCount = lines.filter(l => l.kind !== '+').length
  const newCount = lines.filter(l => l.kind !== '-').length
  const oldStart = oldCount > 0 ? first.oldBefore + 1 : first.oldBefore
  const newStart = newCount > 0 ? first.newBefore + 1 : first.newBefore
  const body = lines.map(l => l.kind + l.text).join('\n')

  return clip(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${body}`)
}

/** The new side's text, for `Code` drawn as plain source. */
export function toSource(lines: DiffLine[]): string {
  return clip(
    lines
      .filter(l => l.kind !== '-')
      .map(l => l.text)
      .join('\n'),
  )
}

function clip(text: string): string {
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')

  return clean.length > CODE_LIMIT ? clean.slice(0, clean.lastIndexOf('\n', CODE_LIMIT)) : clean
}
