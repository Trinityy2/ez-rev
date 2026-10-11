# ez-rev

A Claude Code mod for reviewing AI-written code. Claude splits a change into the components that make it work, orders
them so each builds on the last, and walks you through them one at a time in a pane beside the conversation. Lines
that use third-party symbols or hard-to-track variables can be expanded inline to show what they are.

## Install

```sh
claude plugin marketplace add Trinityy2/ez-rev
claude plugin install ez-rev@ez-rev
```

Restart Claude Code, or run `/reload-plugins` in a running session.

## Use

```
/ez-rev                                         # review the uncommitted changes in this repo
/ez-rev the last commit
/ez-rev the last 3 commits in ~/Projects/other-repo
```

Claude reads the changes and opens the review in the pane. You can also just ask it to "review this with ez-rev".

Each chunk shows:

- the component's title and what it does for the goal, plus what to check;
- its code as a diff against the base (`d` switches to plain source);
- annotated lines, highlighted across the row. Click anywhere on one (or Tab to it and press Enter) to open its notes:
  what a library symbol is, with a docs link, or where a variable comes from and where it goes next.

After the last chunk an overview explains how the components fit together, with a checklist of the chunks.

| Key | Does                                                      |
| --- | --------------------------------------------------------- |
| `n` | next chunk                                                |
| `p` | previous chunk                                            |
| `o` | overview                                                  |
| `r` | mark the chunk reviewed and move on                       |
| `d` | switch between diff and source                            |
| `e` | expand or collapse every note in the chunk                |
| `a` | put a reference to the chunk in your prompt to ask about it |

Keys work while the pane has focus (click it, or `ctrl+x tab`).

## How it works

The mod (`plugin/hooks/register.tsx`) registers a pane, the `/ez-rev` command and three tools Claude calls:

- `review_plan`: opens a review with a goal, an overview and ordered chunks. Each chunk is a line range in one file. A
  review can target another repo (`repo`) and a commit range (`base`, `head`); by default it's the working tree against
  `HEAD`.
- `review_annotate`: adds notes to a chunk, so the pane can open before Claude has finished looking things up.
- `review_goto`: moves the pane to the chunk Claude is talking about.

The mod reads each chunk's lines itself from `git diff`, so the pane shows the real code, not Claude's copy of it.
Notes are only kept on code; notes on prose files (`.md`, `.rst`, `.txt`, ...) are dropped.

## Develop

```sh
claude plugin validate plugin   # checks the manifest and what the hooks module does
claude plugin test plugin       # runs plugin/hooks/*.test.tsx
claude --plugin-dir ./plugin    # a session with the working copy loaded; saving a file reloads it
```

## To do

- **Make the review notes more useful.** The pane works, but what Claude writes into it is still thin: notes often
  restate the code instead of explaining it, and the chunk purposes don't yet say much about what could go wrong.
  Directions to try:
  - prompt for risks per chunk (edge cases, error paths, what changed in behaviour), not just a description;
  - check notes against the real source of the library (installed package, docs) and cite the line;
  - for variables, show every place they're read and written across the chunks;
  - let the person flag a chunk as unclear and have Claude rewrite its notes;
  - measure against a few real reviews and keep what actually helped.
- Notes can only attach to lines in the new version of a file, so removed lines can't be annotated.
- Deleted files can't be shown as a chunk.
- The colours are chosen for dark terminal themes.
