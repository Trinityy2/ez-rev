export type NoteKind = 'library' | 'variable' | 'function' | 'keyword'

/** One inline definition, pinned to a line of the new file. */
export type Note = {
  line: number
  name: string
  kind: NoteKind
  summary: string
  details?: string
  docsUrl?: string
  /** The package it comes from, or where a variable is defined. */
  source?: string
}

/** One line of a chunk, as the diff against the base has it. */
export type DiffLine = {
  kind: ' ' | '+' | '-'
  text: string
  oldBefore: number
  newBefore: number
}

export type Chunk = {
  title: string
  purpose: string
  file: string
  startLine: number
  endLine: number
  notes: Note[]
  lines: DiffLine[]
  hasChanges: boolean
  error?: string
}

export type Plan = {
  goal: string
  overview: string
  /** Absolute path of the repository's top level. */
  repo: string
  base: string
  /** The revision under review; empty for the working tree. */
  head: string
  chunks: Chunk[]
}

declare module 'claude-code' {
  interface PluginState {
    'ez-rev': {
      plan: Plan | null
      cursor: number
      expanded: string[]
      reviewed: number[]
      showDiff: boolean
    }
  }
}
