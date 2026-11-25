# Todo Nag List

Claude keeps asking you to do things and then scrolls them out of sight; this keeps them in one list, pinned above your prompt.

![The band above the prompt and the /qs pane, with sample q's](docs/screenshot.png)

*Sample data. Left: the line above the prompt. Right: the `/qs` pane.*

## Quickstart

1. In a Claude Code terminal session, run:
   ```
   /plugin install qs --marketplace matthandlersux/claude-todo-naglist
   ```
   Answer `y` to add the marketplace, then pick a scope.
2. Run `/qs setup`. It makes your own private claude.ai page that holds the list (allow the `Artifact`
   call when asked). Once per account: later sessions remember it.
3. When Claude first asks to use `ArtifactData`, choose **always allow** (details below).
4. Work as usual. Whenever Claude leaves you something to do, decide or answer, a 📌 line appears above the prompt.
5. Type `/qs` to open the list, then press **Done**, **Dismiss** or a reply button. Open the page from step 2 on
   your phone to do the same there.

## What it does

A Claude Code mod (plugin name `qs`). Every to-do, decision or question a session leaves you (a "q")
goes into one list on your claude.ai account, with the count kept in sight.

- **Captured as Claude writes.** Claude gets four tools (`qs_add`, `qs_resolve`, `qs_list`, `qs_order`) and a
  system-prompt note telling it to file each to-do, decision or question for you, one per item, and to
  close items when you say you did them or answer them.
- **Every ask is judged.** Claude must guess two things when it files one: **urgency** (time: `now` = today
  or something waits on it, `soon` = this week, `later` = no clock) and **ignorable** (true only if nothing
  real is tied to it, blocked on it or half done), plus what it blocks.
- **Steps stay in order.** When q's belong to one task or must be done in turn, Claude gives them a shared
  **group** tag (e.g. `router-swap`) and step numbers. A group is listed together, in step order, where its most
  pressing q would sit. `qs_order` groups or reorders q's already filed.
- **Re-ranked as things change.** A triage pass (sonnet) re-judges every open ask across all your sessions
  and folders and puts them in order: every 6 hours, or 20 minutes after the last pass when new asks are
  waiting. New asks sort to the top of their urgency until a pass places them. Only one session runs a pass
  at a time (a claim doc in collection `asksMeta`). `/qs triage` runs one now.
- **Reply buttons.** When your part is just clicking (approve a push, pick A or B), Claude files the q with
  2-3 buttons, e.g. **Push** / **Not yet**. Click one in the pane or on your phone: the q closes with that
  answer and the session that filed it gets it as your reply and carries on. From the phone it arrives within
  a minute (each session checks once a minute); a closed session gets it when you resume it.
- **Short titles, context underneath.** Each q is a title to skim (5-10 words; over 80 characters is refused)
  plus a `detail`: what it refers to, why, and any link, path or command, written for when you have
  forgotten the conversation. The pane and the phone page show the detail under the title.
- **Sessions clean up after themselves.** Each message you send carries a note of that session's open q's,
  so Claude closes what you just said is done, and what its own work settled, without being asked.
- **Safety net.** After a reply a cheap model call (haiku) checks for q's Claude forgot to file and adds
  them, and closes this session's q's that your message or the reply plainly settled (both marked `sweep`).
  It runs after longer replies and after any reply while the session has open q's. It never holds up the
  turn. Can be switched off.
- **Always visible.** A line above the prompt: `📌 3 q's for you · 1 do · 1 decide · 1 answer   (7 in this folder)   /qs`.
  Nothing shows when there are none.
- **A pane** (`/qs`): Session / Folder / All tabs, in priority order (urgency, then not-ignorable, then the
  last triage's rank), with Done and Dismiss buttons.
- **Your phone.** The list lives in the database of your private claude.ai page (made by `/qs setup`).
  Open it anywhere you're signed in to Claude, tick things off there.
  Priority order by default, or grouped by folder.

## Install

At the prompt of a terminal session: `/plugin install qs --marketplace matthandlersux/claude-todo-naglist`.
From a shell: `claude plugin install qs --marketplace matthandlersux/claude-todo-naglist`.

### Updating from 0.2

- Run `/qs names` once: q's that were named after a session's first message get the session's title.
- Ask Claude to republish `page/asks.html` from the plugin folder to your page's link, so your phone shows each q's detail.
- q's filed before 0.3 keep their long titles and have no detail.

### Updating from 0.1

0.1 kept everyone's q's on one built-in page; 0.2 has no default page. After updating, run these once:

1. `/qs setup <your page's link>` to keep using the page you had (the link the pane showed, `https://claude.ai/artifact/...`). Skip it to start a fresh page with `/qs setup`.
2. `/qs names` to give your older q's their sessions' names (each session's title, read from the transcripts Claude Code keeps on this computer) instead of "session from <date>". q's from sessions on another computer, or whose transcripts were deleted, keep the date label.

New q's get names by themselves. Your phone page shows the new names and groups once it runs 0.2's page: `/qs setup` with no link makes a new page; to update the one you have, ask Claude to republish `page/asks.html` from the plugin folder to your page's link.

To stop using it: `/plugin uninstall qs` (your list stays on the claude.ai page).

## Allow ArtifactData

The mod reads and writes the list through Claude Code's built-in `ArtifactData` tool, which goes through
the normal permission check. The first time, you'll be asked: choose to always allow `ArtifactData`
(or add `"ArtifactData"` to `permissions.allow` in `~/.claude/settings.json`). Otherwise you'll be asked on every refresh.

## Commands

| Command | What it does |
|---|---|
| `/qs` | Open the pane |
| `/qs setup` | Make your private list page (once), or `/qs setup <link>` to use a page you already have |
| `/qs done <n>` | Mark this session's item number `n` done (numbers as the pane shows them, in priority order) |
| `/qs dismiss <n>` | Dismiss item `n` |
| `/qs triage` | Re-rank every open ask now |
| `/qs names` | Put each session's title on its q's, replacing "session from <date>" and names taken from a first message; run once after updating |
| `/qs off` | Stop capturing in this session: no prompt note, no sweep, no band; the tools answer that capture is off |
| `/qs on` | Turn it back on (on is the default) |

## Options (`/config`, or `pluginConfigs` in settings)

| Option | Default | Meaning |
|---|---|---|
| `artifactUrl` | empty | The claude.ai page whose database (collection `asks`) holds the list. Empty: the page `/qs setup` made |
| `sweep` | `true` | The after-reply safety-net check |

## How it stores things

One document per q in the page's `asks` collection (the name predates the rename): `text` (the title), `detail` (the context), `kind` (do/decide/answer), `status`
(open/done/dismissed), `folder` (the git root, else the working directory), `folderName`, `sessionId`,
`sessionName` (the session's title), `sessionStarted`, `createdAt`,
`closedAt`, `closedBy` (session/pane/page/sweep), `source` (tool/sweep), `urgency` (now/soon/later),
`ignorable`, `blocks`, `options` (reply buttons), `answer`, `answeredAt`, `deliveredAt`, `rank` (the last triage's position, null until triaged), `triagedAt`, `group` (task tag, '' for none), `step` (place in the group).
Sessions are named by their title (the one you gave, else the one Claude Code generated, read from the session's transcript), and by the first line of their first prompt only until a title exists (`sessionName`).
Collection `asksMeta`, doc `triage`: `lastRun`, `runningUntil` (the claim). The database is the truth; the
session keeps a cache of the open ones, refreshed when the pane opens, after each write, at the start
and end of every turn, and every minute while the pane is open.

## Developing

`claude plugin validate .` and `claude plugin test .` (tests in `tests/`).
