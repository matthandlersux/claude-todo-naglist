# asks: one list of everything Claude asks of you

A Claude Code mod. Claude sessions keep leaving you things: something to run, a decision, a question.
The conversation scrolls, and by the time you deal with item 1, items 2 to 5 are gone. This mod
files every one of them into one list on your claude.ai account and keeps the count in sight.

- **Captured as Claude writes.** Claude gets three tools (`asks_add`, `asks_resolve`, `asks_list`) and a
  system-prompt note telling it to file each to-do, decision or question for you, one per item, and to
  close items when you say you did them or answer them.
- **Safety net.** After each longer reply a cheap model call (haiku) checks for asks Claude forgot to file
  and adds them (marked `sweep`). It never holds up the turn. Can be switched off.
- **Always visible.** A line above the prompt: `3 open for you · 1 do · 1 decide · 1 answer   (7 in this folder)   /asks`.
  Nothing shows when there are none.
- **A pane** (`/asks`): Session / Folder / All tabs, grouped by folder then session, newest first,
  with Done and Dismiss buttons.
- **Your phone.** The list lives in the database of a private claude.ai page:
  https://claude.ai/artifact/HNv6tEtKy3rXX2QzkVqRHs. Open it anywhere you're signed in to Claude, tick things off there.

## Install

At the prompt of a terminal session:

```
/plugin install asks --marketplace <owner>/claude-asks
```

Answer `y` to add the marketplace, then pick a scope. (From a shell: `claude plugin install asks --marketplace <owner>/claude-asks`.)

## Allow ArtifactData

The mod reads and writes the list through Claude Code's built-in `ArtifactData` tool, which goes through
the normal permission check. The first time, you'll be asked: choose to always allow `ArtifactData`
(or add `"ArtifactData"` to `permissions.allow` in `~/.claude/settings.json`). Otherwise you'll be asked on every refresh.

## Commands

| Command | What it does |
|---|---|
| `/asks` | Open the pane |
| `/asks done <n>` | Mark this session's item number `n` done (numbers as the pane shows them, newest first) |
| `/asks dismiss <n>` | Dismiss item `n` |
| `/asks off` | Stop capturing in this session: no prompt note, no sweep, no band; the tools answer that capture is off |
| `/asks on` | Turn it back on (on is the default) |

## Options (`/config`, or `pluginConfigs` in settings)

| Option | Default | Meaning |
|---|---|---|
| `artifactUrl` | the page above | The claude.ai page whose database (collection `asks`) holds the list |
| `sweep` | `true` | The after-reply safety-net check |

## How it stores things

One document per ask in the page's `asks` collection: `text`, `kind` (do/decide/answer), `status`
(open/done/dismissed), `folder` (the git root, else the working directory), `folderName`, `sessionId`,
`sessionName` (the session's title when Claude Code reports one), `sessionStarted`, `createdAt`,
`closedAt`, `closedBy` (session/pane/page), `source` (tool/sweep). The database is the truth; the
session keeps a cache of the open ones, refreshed when the pane opens, after each write, at the start
and end of every turn, and every minute while the pane is open.

## Developing

`claude plugin validate .` and `claude plugin test .` (tests in `tests/`).
