import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Chunk, DiffLine, Note, NoteKind, Plan } from '../types'
import { parseDiff, plainLines, segment, sliceRange, strayNotes, toHunk, toSource } from './diff'
import type { Segment } from './diff'

const PANE = 'ez-rev'
const TITLE = 'Review'

const plan = atom({ plugin: 'ez-rev', key: 'plan' } as const, null)
const cursor = atom({ plugin: 'ez-rev', key: 'cursor' } as const, 0)
const expanded = atom({ plugin: 'ez-rev', key: 'expanded' } as const, [])
const reviewed = atom({ plugin: 'ez-rev', key: 'reviewed' } as const, [])
const showDiff = atom({ plugin: 'ez-rev', key: 'showDiff' } as const, true)

const KINDS: NoteKind[] = ['library', 'function', 'variable', 'keyword']
const KIND_TAG: Record<NoteKind, string> = {
  library: 'lib',
  function: 'fn',
  variable: 'var',
  keyword: 'kw',
}
const KIND_COLOR: Record<NoteKind, string> = {
  library: 'magenta',
  function: 'yellow',
  variable: 'green',
  keyword: 'blue',
}
// An annotated line keeps the diff's colours; only the panel its notes open into is tinted apart.
const ADDED_BG = '#1e3a24'
const NOTES_BG = '#1c2a35'
// An annotated line under the pointer, or with its notes open: lit across the whole row.
const LIT_BG = '#34405a'
const LIT_ADDED_BG = '#2d5a37'
// Prose has no symbols worth defining: notes on these files are dropped.
const PROSE = /\.(md|mdx|markdown|rst|txt|adoc)$/i
const ACCENT = 'cyan'

const NOTE_SCHEMA = {
  type: 'object',
  properties: {
    line: { type: 'number', description: 'Line number in the NEW file where the symbol appears.' },
    name: { type: 'string', description: 'The symbol as written in the code, e.g. `np.einsum` or `retry_budget`.' },
    kind: {
      type: 'string',
      enum: KINDS,
      description:
        'library: a third-party/community import, class or module. function: a third-party or non-obvious project function. variable: a variable worth tracking through the code. keyword: an uncommon language feature or decorator.',
    },
    summary: { type: 'string', description: 'One line: what it is / what it holds.' },
    details: {
      type: 'string',
      description:
        'Markdown. For library/function: signature, what the arguments mean here, gotchas. For variable: where it is defined, what it holds, where it flows next (file:line).',
    },
    docsUrl: { type: 'string', description: 'Link to the official documentation, when one exists.' },
    source: { type: 'string', description: 'Package it comes from (e.g. `httpx`), or `file:line` where a variable is defined.' },
  },
  required: ['line', 'name', 'kind', 'summary'],
}

const PLAN_DESCRIPTION = `Opens the ez-rev review pane beside the conversation and fills it with a chunked review of code changes, so the person can review AI-written code component by component.

How to chunk:
- First work out the GOAL the changes serve. Then split the changes into the COMPONENTS that make the solution work: each chunk is one component (a data model, a parser, a handler, the wiring that connects them), not one file or one hunk.
- ORDER chunks so each builds on the ones before it: foundations (types, data, config) first, then the logic that uses them, then the wiring/entry points, then tests.
- Each chunk is one contiguous line range in one file, ideally under ~80 lines. A component spread across files becomes several consecutive chunks with related titles.
- 'purpose' explains what this component does for the goal and what to look for when reviewing it. Do not just restate the code.
- 'overview' (markdown) is shown after the last chunk: how the components work together, end to end, to reach the goal (data flow, call order).

Notes (inline definitions, shown as collapsible rows under the line they belong to):
- Only annotate source code. Never add notes to documentation or prose files (README, .md, .rst, .txt): the pane drops them.
- Add a note for third-party / community library symbols (NOT the language's standard library), uncommon project functions, uncommon language keywords, and for variables whose meaning or origin is hard to track (defined elsewhere, mutated across chunks, new state).
- Look the library symbols up (installed package source, docs) rather than guessing; include docsUrl.
- Notes can also be added later with review_annotate, so you may open the plan first and annotate after.

Calling this again replaces the current review.`

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    goal: { type: 'string', description: 'One or two sentences: what these changes achieve.' },
    overview: { type: 'string', description: 'Markdown shown after the last chunk: how the components fit together.' },
    repo: { type: 'string', description: 'Path of the git repository under review (absolute, ~/..., or relative to the session). Default: the session\'s working directory. Chunk files are relative to its top level.' },
    base: { type: 'string', description: 'Git revision the changes are diffed against. Default: HEAD, or `<head>~1` when head is given.' },
    head: { type: 'string', description: 'Git revision under review, e.g. `HEAD` or a commit sha. Default: the working tree (uncommitted changes). To review the last commit: head `HEAD` (base defaults to `HEAD~1`).' },
    chunks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The component, e.g. "Retry policy: backoff calculation".' },
          purpose: { type: 'string', description: 'Markdown: its role in the goal and what to check.' },
          file: { type: 'string', description: 'Path relative to the repository\'s top level.' },
          startLine: { type: 'number', description: 'First line in the NEW version of the file.' },
          endLine: { type: 'number', description: 'Last line in the NEW version of the file.' },
          notes: { type: 'array', items: NOTE_SCHEMA },
        },
        required: ['title', 'purpose', 'file', 'startLine', 'endLine'],
      },
    },
  },
  required: ['goal', 'overview', 'chunks'],
}

const ANNOTATE_SCHEMA = {
  type: 'object',
  properties: {
    chunk: { type: 'number', description: '1-based chunk number.' },
    notes: { type: 'array', items: NOTE_SCHEMA },
    replace: { type: 'boolean', description: 'Replace the chunk\'s notes instead of adding to them.' },
  },
  required: ['chunk', 'notes'],
}

const GOTO_SCHEMA = {
  type: 'object',
  properties: {
    chunk: { type: 'number', description: '1-based chunk number, or 0 for the overview of how everything fits together.' },
  },
  required: ['chunk'],
}

type ChunkArgs = { title: string; purpose: string; file: string; startLine: number; endLine: number; notes?: Note[] }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ez-rev',
      description: 'Open the review pane; with an argument, ask Claude to prepare a chunked review of it',
      argumentHint: '[what to review]',
    })
    await $.tool.register({ name: 'review_plan', description: PLAN_DESCRIPTION, inputSchema: PLAN_SCHEMA })
    await $.tool.register({
      name: 'review_annotate',
      description:
        'Adds inline definitions (third-party symbols, tracked variables) to one chunk of the open ez-rev review. Each note is drawn as a collapsible row under its line.',
      inputSchema: ANNOTATE_SCHEMA,
    })
    await $.tool.register({
      name: 'review_goto',
      description:
        'Moves the ez-rev review pane to a chunk, so the person sees the code you are talking about. Use it whenever the discussion moves to another chunk.',
      inputSchema: GOTO_SCHEMA,
    })

    return next(e)
  })

  on('command.run', { command: 'ez-rev' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: TITLE })
    const target = e.args.trim()
    const current = await read($, plan)

    if (target === '' && current !== null) return { text: 'Review pane opened.' }

    // The submitted turn starts only once this command has finished, so it is not awaited.
    void $.prompt.submit({
      text: `Prepare an ez-rev review of ${target === '' ? 'the uncommitted changes in this repository (git diff HEAD, plus untracked files)' : target}. Read the changed code, work out the goal, then call review_plan with the chunks in review order. Afterwards, look up the third-party symbols and hard-to-track variables and add them with review_annotate. Then give me a short spoken walkthrough of chunk 1.`,
    })

    return { text: 'Review pane opened; asking Claude to prepare the review.' }
  })

  on('tool.call', { tool: 'mcp__ez-rev__review_plan' }, async ($, e) => {
    const repo = await resolveRepo($, typeof e.repo === 'string' ? e.repo : '')
    if (repo === undefined) return { deny: `${String(e.repo)} is not inside a git repository.` }
    const head = typeof e.head === 'string' ? e.head.trim() : ''
    const base = typeof e.base === 'string' && e.base.trim() !== '' ? e.base.trim() : head !== '' ? `${head}~1` : 'HEAD'
    const asked = (e.chunks ?? []) as ChunkArgs[]
    const chunks: Chunk[] = []
    for (const one of asked) chunks.push(await loadChunk($, { repo, base, head }, one))

    const fresh: Plan = { goal: String(e.goal ?? ''), overview: String(e.overview ?? ''), repo, base, head, chunks }
    await update($, plan, () => fresh)
    await update($, cursor, () => 0)
    await update($, expanded, () => [])
    await update($, reviewed, () => [])
    await $.ui.open({ id: PANE, title: TITLE })

    const problems = chunks
      .map((c, i) => (c.error ? `chunk ${i + 1} (${c.file}): ${c.error}` : undefined))
      .filter(Boolean)
    const unchanged = chunks.filter(c => !c.hasChanges && !c.error).length
    const dropped = asked.filter(c => PROSE.test(String(c.file)) && (c.notes ?? []).length > 0).map(c => c.file)

    return {
      result: [
        `Review opened with ${chunks.length} chunks of ${repo} (${rangeLabel(fresh)}).`,
        unchanged > 0 ? `${unchanged} chunk(s) show no changes against ${base}; that is fine for context, otherwise check the base.` : '',
        problems.length > 0 ? `Problems:\n${problems.join('\n')}` : '',
        dropped.length > 0 ? `Notes on prose files were dropped (${[...new Set(dropped)].join(', ')}): only code is annotated.` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  })

  on('tool.call', { tool: 'mcp__ez-rev__review_annotate' }, async ($, e) => {
    const current = await read($, plan)
    const index = Number(e.chunk) - 1
    if (current === null) return { deny: 'No review is open; call review_plan first.' }
    if (!current.chunks[index]) return { deny: `There is no chunk ${e.chunk}; the review has ${current.chunks.length}.` }

    const notes = (e.notes ?? []) as Note[]
    if (PROSE.test(current.chunks[index]!.file) && notes.length > 0)
      return { deny: `Chunk ${e.chunk} is prose (${current.chunks[index]!.file}); only code is annotated.` }
    await update($, plan, p => {
      if (p === null) return p
      const chunks = p.chunks.map((c, i) => {
        if (i !== index) return c
        const kept = e.replace === true ? [] : c.notes.filter(old => !notes.some(n => n.line === old.line && n.name === old.name))
        return { ...c, notes: [...kept, ...notes].sort((a, b) => a.line - b.line) }
      })
      return { ...p, chunks }
    })

    const chunk = current.chunks[index]!
    const outside = notes.filter(n => n.line < chunk.startLine || n.line > chunk.endLine)

    return {
      result:
        `Added ${notes.length} note(s) to chunk ${index + 1}.` +
        (outside.length > 0
          ? ` ${outside.map(n => n.name).join(', ')} fall outside lines ${chunk.startLine}-${chunk.endLine} and are listed under "Other references".`
          : ''),
    }
  })

  on('tool.call', { tool: 'mcp__ez-rev__review_goto' }, async ($, e) => {
    const current = await read($, plan)
    if (current === null) return { deny: 'No review is open; call review_plan first.' }

    const asked = Number(e.chunk)
    const step = asked === 0 ? current.chunks.length : Math.min(Math.max(asked - 1, 0), current.chunks.length - 1)
    await update($, cursor, () => step)
    await $.ui.open({ id: PANE, title: TITLE })

    return { result: asked === 0 ? 'Showing the overview.' : `Showing chunk ${step + 1}: ${current.chunks[step]!.title}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code, Markdown } = $.ui.resolve(e)
    const current = await read($, plan)

    if (current === null) {
      return (
        <Box flexDirection="column">
          <Text bold>ez-rev</Text>
          <Text dimColor>No review yet. Run /ez-rev [what to review], or ask Claude to "review my changes with ez-rev".</Text>
        </Box>
      )
    }

    const total = current.chunks.length
    const step = Math.min(await read($, cursor), total)
    const done = await read($, reviewed)
    const open = await read($, expanded)
    const isDiff = await read($, showDiff)
    const isOverview = step === total

    const go = (to: number) => update($, cursor, () => Math.min(Math.max(to, 0), total))

    const header = (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold wrap="wrap">
          Goal: {current.goal}
        </Text>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Text dimColor>
            {repoName(current.repo)} · {rangeLabel(current)} · {isOverview ? `Overview` : `Chunk ${step + 1}/${total}`} ·{' '}
            {done.length}/{total} reviewed
          </Text>
          <Button key="prev" hotkey="p" plain label="prev" onPress={() => go(step - 1)} />
          <Button key="next" hotkey="n" plain label="next" onPress={() => go(step + 1)} />
          <Button key="overview" hotkey="o" plain label="overview" onPress={() => go(total)} />
        </Box>
      </Box>
    )

    if (isOverview) {
      return (
        <Box flexDirection="column">
          {header}
          <Text bold>How it fits together</Text>
          <Markdown text={clipText(current.overview || '_No overview given._')} />
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Components</Text>
            {current.chunks.map((c, i) => (
              <Button
                key={`jump-${i}`}
                plain
                dimColor={!done.includes(i)}
                label={`${done.includes(i) ? '✓' : '·'} ${i + 1}. ${c.title}  (${c.file}:${c.startLine}-${c.endLine})`}
                onPress={() => go(i)}
              />
            ))}
          </Box>
        </Box>
      )
    }

    const chunk = current.chunks[step]!
    const isDone = done.includes(step)
    const asDiff = isDiff && chunk.hasChanges
    const notes = PROSE.test(chunk.file) ? [] : chunk.notes
    const parts = segment(chunk.lines, notes)
    const stray = strayNotes(chunk.lines, notes)
    const strayKey = `${step}:other`
    const allKeys = [
      ...parts.flatMap(part => (part.type === 'line' ? [lineKey(step, part.number)] : [])),
      ...(stray.length > 0 ? [strayKey] : []),
    ]
    const isAllOpen = allKeys.length > 0 && allKeys.every(k => open.includes(k))
    const gutter = String(chunk.endLine).length

    const toggle = (key: string) =>
      update($, expanded, keys => (keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key]))

    const notesPanel = (notes: Note[]) => (
      <Box
        flexDirection="column"
        marginLeft={2}
        paddingX={1}
        borderStyle="round"
        borderColor={ACCENT}
        backgroundColor={NOTES_BG}
      >
        {notes.map((note, i) => (
          <Box flexDirection="column" marginTop={i === 0 ? 0 : 1}>
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Text bold color={ACCENT}>
                {note.name}
              </Text>
              <Text bold color="black" backgroundColor={KIND_COLOR[note.kind] ?? 'gray'}>
                {` ${KIND_TAG[note.kind] ?? note.kind} `}
              </Text>
              {note.source && <Text dimColor>{note.source}</Text>}
              {note.line < chunk.startLine || note.line > chunk.endLine ? <Text dimColor>line {note.line}</Text> : null}
            </Box>
            <Markdown text={clipText(noteMarkdown(note))} />
          </Box>
        ))}
      </Box>
    )

    // A row that opens its notes when pressed anywhere: one Button whose label is the whole row (marker, line
    // number, code, then the count at the right edge), so every cell of it is the control. It lights under the
    // pointer and while open.
    const toggleRow = (key: string, prefix: string, label: string, notes: Note[], isAdded: boolean) => {
      const isOpen = open.includes(key)
      const count = `${notes.length} ${notes.length === 1 ? 'note' : 'notes'} ${isOpen ? '▲' : '▼'}`
      const head = `${isOpen ? '▼' : '▶'} ${prefix}${label}`
      const gap = Math.max(2, e.props.bodyColumns - 1 - cellWidth(head) - count.length)

      return (
        <Box flexDirection="column">
          <Box
            key={`row-${key}`}
            backgroundColor={isOpen ? (isAdded ? LIT_ADDED_BG : LIT_BG) : isAdded ? ADDED_BG : undefined}
            hover={{ backgroundColor: isAdded ? LIT_ADDED_BG : LIT_BG }}
          >
            <Button key={`line-${key}`} plain label={head + ' '.repeat(gap) + count} onPress={() => toggle(key)} />
          </Box>
          {isOpen && notesPanel(notes)}
        </Box>
      )
    }

    const lineRow = (part: Extract<Segment, { type: 'line' }>) =>
      toggleRow(
        lineKey(step, part.number),
        `${String(part.number).padStart(gutter)} ${asDiff ? (part.line.kind === '+' ? '+' : ' ') + ' ' : ''}`,
        codeLabel(part.line.text),
        part.notes,
        asDiff && part.line.kind === '+',
      )

    return (
      <Box flexDirection="column">
        {header}
        <Text bold color="cyan" wrap="wrap">
          {isDone ? '✓ ' : ''}
          {step + 1}. {chunk.title}
        </Text>
        <Text dimColor>
          {chunk.file}:{chunk.startLine}-{chunk.endLine}
          {chunk.hasChanges ? '' : `  (no changes vs ${current.base})`}
        </Text>
        <Box marginY={1}>
          <Markdown text={clipText(chunk.purpose)} />
        </Box>
        {chunk.error && <Text color="red">{chunk.error}</Text>}
        {parts.map(part =>
          part.type === 'code' ? (
            asDiff ? (
              <Code source={toHunk(part.lines)} format="diff" path={chunk.file} />
            ) : hasNewSide(part.lines) ? (
              <Code source={toSource(part.lines)} path={chunk.file} startLine={firstNew(part.lines)} />
            ) : null
          ) : (
            lineRow(part)
          ),
        )}
        {stray.length > 0 && <Box marginTop={1}>{toggleRow(strayKey, '', 'Other references', stray, false)}</Box>}
        <Box flexDirection="row" gap={1} marginTop={1} flexWrap="wrap">
          <Button
            key="reviewed"
            hotkey="r"
            variant="primary"
            label={isDone ? 'unmark reviewed' : 'mark reviewed'}
            onPress={async () => {
              await update($, reviewed, list => (list.includes(step) ? list.filter(i => i !== step) : [...list, step]))
              if (!isDone) await go(step + 1)
            }}
          />
          {chunk.hasChanges && (
            <Button key="diff" hotkey="d" label={asDiff ? 'show source' : 'show diff'} onPress={() => update($, showDiff, v => !v)} />
          )}
          {allKeys.length > 0 && (
            <Button
              key="all"
              hotkey="e"
              label={isAllOpen ? 'collapse notes' : 'expand notes'}
              onPress={() =>
                update($, expanded, keys =>
                  isAllOpen ? keys.filter(k => !allKeys.includes(k)) : [...new Set([...keys, ...allKeys])],
                )
              }
            />
          )}
          <Button
            key="ask"
            hotkey="a"
            label="ask about this"
            onPress={() =>
              $.prompt.fill({
                text: `[ez-rev chunk ${step + 1}: ${chunk.title} — ${repoName(current.repo)}/${chunk.file}:${chunk.startLine}-${chunk.endLine}] `,
                mode: 'insert',
              })
            }
          />
        </Box>
      </Box>
    )
  })
}

type Range = { repo: string; base: string; head: string }

async function resolveRepo($: EngineInterface, asked: string): Promise<string | undefined> {
  const cwd = await $.session.cwd()
  let path = asked.trim()
  if (path === '') path = cwd
  else if (path === '~' || path.startsWith('~/')) path = `${(await $.env.get('HOME')) ?? ''}${path.slice(1)}`
  else if (!path.startsWith('/')) path = `${cwd}/${path}`

  const top = await $.process.run(['git', '-C', path, 'rev-parse', '--show-toplevel'])

  return top.exitCode === 0 ? top.stdout.trim() : undefined
}

function rangeLabel(p: Range): string {
  return p.head === '' ? `${p.base}..working tree` : `${p.base}..${p.head}`
}

function repoName(repo: string): string {
  return repo.split('/').filter(Boolean).pop() ?? repo
}

async function loadChunk($: EngineInterface, range: Range, args: ChunkArgs): Promise<Chunk> {
  const startLine = Math.max(1, Math.floor(Number(args.startLine) || 1))
  const endLine = Math.max(startLine, Math.floor(Number(args.endLine) || startLine))
  const chunk: Chunk = {
    title: String(args.title ?? ''),
    purpose: String(args.purpose ?? ''),
    file: String(args.file ?? ''),
    startLine,
    endLine,
    notes: PROSE.test(String(args.file ?? '')) ? [] : [...(args.notes ?? [])].sort((a, b) => a.line - b.line),
    lines: [],
    hasChanges: false,
  }

  try {
    const lines = await fileLines($, range, chunk.file)
    chunk.lines = sliceRange(lines, startLine, endLine)
    chunk.hasChanges = chunk.lines.some(l => l.kind !== ' ')
    if (chunk.lines.length === 0) chunk.error = `Lines ${startLine}-${endLine} are outside the file.`
  } catch (err) {
    chunk.error = `Could not read ${chunk.file}: ${err instanceof Error ? err.message : String(err)}`
  }

  return chunk
}

async function fileLines($: EngineInterface, { repo, base, head }: Range, file: string): Promise<DiffLine[]> {
  const git = (...argv: string[]) => $.process.run(['git', '-C', repo, ...argv])
  const revisions = head === '' ? [base] : [base, head]
  const diff = await git('diff', '--no-color', '--no-ext-diff', '-U1000000', ...revisions, '--', file)
  if (diff.exitCode !== 0) throw new Error(diff.stderr.trim() || `git diff exited ${diff.exitCode}`)
  if (diff.stdout.trim() !== '') return parseDiff(diff.stdout)

  if (head !== '') {
    const shown = await git('show', `${head}:${file}`)
    if (shown.exitCode !== 0) throw new Error(shown.stderr.trim() || `not in ${head}`)
    return plainLines(shown.stdout, ' ')
  }

  const text = await $.fs.read(`${repo}/${file}`)
  const tracked = await git('ls-files', '--error-unmatch', '--', file)

  return plainLines(text, tracked.exitCode === 0 ? ' ' : '+')
}

// Terminal cells a string takes: wide (East Asian, emoji) characters take two.
function cellWidth(text: string): number {
  let cells = 0
  for (const ch of text) cells += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1faff}]/u.test(ch) ? 2 : 1
  return cells
}

function lineKey(step: number, line: number): string {
  return `${step}:${line}`
}

function codeLabel(text: string): string {
  const flat = text.replace(/\t/g, '  ').replace(/[\u0000-\u001f\u007f]/g, '')

  return flat.trim() === '' ? ' ' : flat
}

function noteMarkdown(note: Note): string {
  return [
    note.summary,
    note.details ?? '',
    note.docsUrl ? `[Documentation](${note.docsUrl})` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

function hasNewSide(lines: DiffLine[]): boolean {
  return lines.some(l => l.kind !== '-')
}

function firstNew(lines: DiffLine[]): number {
  const first = lines.find(l => l.kind !== '-')

  return first ? first.newBefore + 1 : 1
}

function clipText(text: string): string {
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')

  return clean.length > 9500 ? `${clean.slice(0, 9500)}…` : clean
}
