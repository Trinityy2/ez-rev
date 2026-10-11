import { expect, test } from 'claude-code/testing'

import { parseDiff, segment, sliceRange, strayNotes, toHunk } from './diff'

const DIFF = `diff --git a/app.py b/app.py
index 1111111..2222222 100644
--- a/app.py
+++ b/app.py
@@ -1,5 +1,6 @@
 import os
-import requests
+import httpx
+client = httpx.Client(timeout=5)

 def fetch(url):
     return requests.get(url)
`

const NOTE = { line: 3, name: 'httpx.Client', kind: 'library' as const, summary: 'A pooled HTTP client.' }

test('the diff is numbered against both sides', () => {
  const lines = parseDiff(DIFF)
  expect(lines.map(l => l.kind).join('')).toBe(' -++  ')
  expect(lines[2]).toEqual({ kind: '+', text: 'import httpx', oldBefore: 2, newBefore: 1 })
})

test('a range keeps the removals inside it', () => {
  const lines = sliceRange(parseDiff(DIFF), 2, 3)
  expect(lines.map(l => l.kind + l.text)).toEqual(['-import requests', '+import httpx', '+client = httpx.Client(timeout=5)'])
})

test('an annotated line stands alone between valid hunks', () => {
  const parts = segment(parseDiff(DIFF), [NOTE])
  expect(parts.map(p => p.type)).toEqual(['code', 'line', 'code'])
  if (parts[0]?.type !== 'code' || parts[1]?.type !== 'line' || parts[2]?.type !== 'code') throw new Error('expected code, line, code')
  expect(parts[1].number).toBe(3)
  expect(parts[1].line.text).toBe('client = httpx.Client(timeout=5)')
  expect(toHunk(parts[0].lines).split('\n')[0]).toBe('@@ -1,2 +1,2 @@')
  expect(toHunk(parts[2].lines).split('\n')[0]).toBe('@@ -3,2 +4,2 @@')
})

test('notes outside the range are listed apart', () => {
  const lines = sliceRange(parseDiff(DIFF), 5, 6)
  expect(strayNotes(lines, [NOTE])).toEqual([NOTE])
})

const PANE_PROPS = {
  title: 'Review',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

test('a plan opens on chunk 1 with its notes collapsed, and they expand on press', async ($, on) => {
  on('process.run', ($, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.includes('diff') ? DIFF : e.argv.includes('rev-parse') ? '/work/app\n' : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: '/work' }))

  await $.tool.call({
    tool: 'mcp__ez-rev__review_plan',
    repo: '/work/app',
    head: 'HEAD',
    goal: 'Switch the HTTP client to httpx',
    overview: 'The client is built once and used by `fetch`.',
    chunks: [
      { title: 'Shared client', purpose: 'Builds one client.', file: 'app.py', startLine: 1, endLine: 3, notes: [NOTE] },
      { title: 'fetch', purpose: 'Uses the client.', file: 'app.py', startLine: 5, endLine: 6 },
      { title: 'Docs', purpose: 'Says so.', file: 'README.md', startLine: 1, endLine: 2, notes: [{ ...NOTE, line: 1 }] },
    ],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'ez-rev', surface, component: 'Pane', requestId: 'ez-rev', props: PANE_PROPS })
    expect((await ui.find({ text: /1\. Shared client/ }))).toBeDefined()
    expect(await ui.find({ text: /app · HEAD~1\.\.HEAD/ })).toBeDefined()
    expect(await ui.find({ type: 'Code' })).toBeDefined()

    const toggle = await ui.find({ type: 'Button', text: /client = httpx\.Client\(timeout=5\)/ })
    expect(toggle).toBeDefined()
    expect(toggle!.text).toMatch(/^▶ 3 \+ client = httpx\.Client\(timeout=5\) +1 note ▼$/)
    expect(toggle!.text.length).toBe(PANE_PROPS.bodyColumns - 1)
    expect(await ui.find({ type: 'Markdown', text: /pooled HTTP client/ })).toBeUndefined()
    await ui.press({ key: toggle!.key! })
    expect((await ui.find({ key: toggle!.key! }))?.text).toMatch(/^▼ .*1 note ▲$/)
    expect(await ui.find({ type: 'Markdown', text: /pooled HTTP client/ })).toBeDefined()
    await ui.press({ key: toggle!.key! })

    await ui.press({ key: 'next' })
    expect(await ui.find({ text: /2\. fetch/ })).toBeDefined()
    await ui.press({ key: 'next' })
    expect(await ui.find({ text: /3\. Docs/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /1 note/ })).toBeUndefined()
    await ui.press({ key: 'next' })
    expect(await ui.find({ text: /How it fits together/ })).toBeDefined()
    await ui.press({ key: 'jump-0' })
    await ui.unmount()
  }
})
