// qs (repo claude-todo-naglist): files every to-do, decision and question (a "q") a session
// leaves for the person into one db (an artifact's `asks` collection), shows the count
// above the prompt and lists them in a pane opened by /qs.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ask, AskHere, AskKind, AskTab } from '../types'
import type { Judged } from './db'
import {
  age,
  allAsks,
  bandText,
  baseName,
  close,
  create,
  DbError,
  folderAsks,
  judged,
  cleanOptions,
  markDelivered,
  mightHoldAsks,
  readUndelivered,
  newId,
  parseSweep,
  readOpen,
  readTriageMeta,
  sessionAsks,
  triageChanges,
  triageDue,
  writeTriage,
  writeTriageMeta,
} from './db'

const PLUGIN = 'qs'
const PANE = 'qs'
const OFF_TEXT = "Q's capture is off in this session (turn it on with /qs on)."
const DEFAULT_URL = 'https://claude.ai/artifact/HNv6tEtKy3rXX2QzkVqRHs'

const asksAtom = atom({ plugin: 'qs', key: 'asks' } as const, [])
const hereAtom = atom({ plugin: 'qs', key: 'here' } as const, null)
const offAtom = atom({ plugin: 'qs', key: 'isOff' } as const, false)
const tabAtom = atom({ plugin: 'qs', key: 'tab' } as const, 'session')
const titleAtom = atom({ plugin: 'qs', key: 'title' } as const, '')
const errorAtom = atom({ plugin: 'qs', key: 'error' } as const, '')

// The full names are mcp__<server>__qs_*, where the server name is the engine's (it can lag a
// rename), so hooks match on the ending and the prompt names what tool.register reported.
const TOOL = { add: 'qs_add', resolve: 'qs_resolve', list: 'qs_list' }
const MATCH = { add: /__qs_add$/, resolve: /__qs_resolve$/, list: /__qs_list$/ }

const promptSection = () => `# Q's for the user (qs mod)
Whenever a reply leaves the user something to do, decide or answer, file each one with the \`${TOOL.add}\` tool as part of that reply: one call per item, kind "do", "decide" or "answer", and a short imperative text that makes sense on its own, away from this conversation (name the repo, file, server or thing it is about, and copy in any link, path or command the user needs to act on it).
Every ask needs your best guess at two things, even when unsure:
- urgency (time): "now" if it matters today or something is waiting on it right now, "soon" for this week, "later" if there is no clock on it.
- ignorable: true only if nothing real is tied to it, blocked on it or half done, so it could sit forever without harm. When false, say in blocks what it blocks, is tied to, or what is half done.
- options: when the user's part is just clicking a button (approve a push or deploy, pick A or B, yes/no), give the 2-3 short button labels, e.g. ["Push", "Not yet"]. Their click comes back to this session as a message; then do what it says.
Don't file what you will do yourself, and don't file generic offers like "let me know if you want more".
When the user says they did an item, or answers or decides it, close it with \`${TOOL.resolve}\` (status "done", or "dismissed" when it no longer applies).
Don't re-file an item that is still open: check \`${TOOL.list}\` (this session's open q's with their ids) when unsure.`

const SWEEP_SYSTEM =
  'You find what an assistant reply leaves for the USER to do, decide or answer. You answer with a JSON array only.'

type Options = { artifactUrl: string; sweep: boolean }

// Set by register (which runs again on every load), read by the helpers below.
let url = DEFAULT_URL

// ---- where this session is, and the cache -----------------------------

async function locate($: EngineInterface): Promise<AskHere> {
  const sessionId = await $.session.id()
  let folder = ''
  try {
    folder = (await $.session.repo())?.root ?? ''
  } catch {
    folder = ''
  }
  if (!folder) folder = await $.session.cwd()
  const here = { sessionId, folder }
  const held = await read($, hereAtom)
  if (held?.sessionId !== here.sessionId || held.folder !== here.folder) {
    await update($, hereAtom, () => here)
  }
  return here
}

function fail($: EngineInterface, what: string, err: unknown) {
  const msg = `${what}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300)
  $.ui.log(`${PLUGIN}: ${msg}`, { to: 'debug' })
  void update($, errorAtom, () => msg)
}

async function refresh($: EngineInterface): Promise<Ask[]> {
  await locate($)
  const open = await readOpen($, url)
  await update($, asksAtom, () => open)
  await update($, errorAtom, () => '')
  return open
}

const refreshQuietly = ($: EngineInterface) => refresh($).catch(err => fail($, 'refresh failed', err))

async function fileAsk(
  $: EngineInterface,
  text: string,
  kind: AskKind,
  judgement: Judged,
  source: 'tool' | 'sweep',
  options: string[] = [],
): Promise<Ask> {
  const here = await locate($)
  const now = await $.clock.now()
  let started = ''
  try {
    started = new Date((await $.session.usage()).startedAt).toISOString()
  } catch {
    started = new Date(now).toISOString()
  }
  const ask: Ask = {
    id: newId(now),
    version: 0,
    text: text.trim(),
    kind,
    status: 'open',
    folder: here.folder,
    folderName: baseName(here.folder),
    sessionId: here.sessionId,
    sessionName: await read($, titleAtom),
    sessionStarted: started,
    createdAt: new Date(now).toISOString(),
    closedAt: null,
    closedBy: null,
    source,
    ...judgement,
    rank: null,
    triagedAt: null,
    options,
    answer: null,
    deliveredAt: null,
  }
  ask.version = await create($, url, ask)
  await update($, asksAtom, list => [...list.filter(a => a.id !== ask.id), ask])
  return ask
}

async function resolveAsk($: EngineInterface, ask: Ask, status: 'done' | 'dismissed', by: string) {
  await close($, url, ask, status, by)
  await update($, asksAtom, list => list.filter(a => a.id !== ask.id))
}

const answerText = (ask: Ask, answer: string) => `Answer to "${ask.text}": ${answer}`

/**
 * A reply button pressed in this session's pane. The ask closes with the answer; when this
 * session filed it, the answer goes straight into the conversation, else the filing session
 * picks it up (deliverAnswers).
 */
async function answerAsk($: EngineInterface, ask: Ask, answer: string) {
  const here = await locate($)
  const isMine = ask.sessionId === here.sessionId
  const now = new Date(await $.clock.now()).toISOString()
  await close($, url, ask, 'done', 'pane', { answer, answeredAt: now, deliveredAt: isMine ? now : null })
  await update($, asksAtom, list => list.filter(a => a.id !== ask.id))
  if (isMine) await $.prompt.submit({ text: answerText(ask, answer), asUser: true })
}

let isDelivering = false

/** Sends answers picked elsewhere (the phone page, another session's pane) into this conversation. */
async function deliverAnswers($: EngineInterface) {
  if (isDelivering || (await read($, offAtom))) return
  isDelivering = true
  try {
    const here = await locate($)
    for (const ask of await readUndelivered($, url, here.sessionId)) {
      const now = new Date(await $.clock.now()).toISOString()
      if (!(await markDelivered($, url, ask, now))) continue
      // answered elsewhere: off the band and pane now, not at the next refresh
      await update($, asksAtom, list => list.filter(a => a.id !== ask.id))
      $.ui.toast(`Answered: ${ask.answer}`)
      await $.prompt.submit({ text: answerText(ask, ask.answer ?? ''), asUser: true })
    }
  } finally {
    isDelivering = false
  }
}

const same = (a: string, b: string) =>
  a.toLowerCase().replace(/\W+/g, ' ').trim() === b.toLowerCase().replace(/\W+/g, ' ').trim()


// The session's title, where the engine reports one.
const keepTitle = async ($: EngineInterface, title: unknown) => {
  if (typeof title === 'string' && title.trim() !== '' && title !== (await read($, titleAtom))) {
    await update($, titleAtom, () => title.trim())
  }
}

async function sweep($: EngineInterface, answer: string) {
  const open = await refresh($).catch(() => read($, asksAtom))
  const here = await read($, hereAtom)
  const filed = sessionAsks(open, here)
    .map(a => `- (${a.kind}) ${a.text}`)
    .join('\n')
  const prompt = `Assistant reply:
<<<
${answer.slice(-6000)}
>>>

Already filed and open:
${filed || '(none)'}

List each thing this reply leaves the USER to do, decide or answer that is NOT already filed (the same meaning counts as filed). Skip what the assistant will do itself, and generic offers ("let me know if..."). Each item: {"options": 2-3 short button labels when the user's part is just picking or approving (e.g. ["Push", "Not yet"]), else [], "text": short imperative that makes sense on its own (copy in any link, path or command from the reply that the user needs to act on it), "kind": "do" | "decide" | "answer", "urgency": "now" (today, or something waits on it) | "soon" (this week) | "later" (no clock), "ignorable": true only if nothing real is tied to it, blocked on it or half done, "blocks": what it blocks or what is half done ("" when ignorable)}. Always guess urgency and ignorable. Answer with a JSON array only; [] when there is nothing.`
  const r = await $.model.complete({
    model: 'haiku',
    system: SWEEP_SYSTEM,
    prompt,
    maxTokens: 800,
    effort: 'low',
    timeoutMs: 45_000,
  })
  if (!r.isAnswered) {
    $.ui.log(`${PLUGIN}: sweep got no answer (${r.reason})`, { to: 'debug' })
    return
  }
  const found = parseSweep(r.text)
  const mine = sessionAsks(await read($, asksAtom), here)
  for (const item of found) {
    if (mine.some(a => same(a.text, item.text))) continue
    await fileAsk($, item.text, item.kind, item, 'sweep', item.options)
  }
  void maybeTriage($, false)
}

// ---- triage: re-rank every open ask across the account ----------------------

const TRIAGE_SYSTEM =
  'You keep one person\'s list of open asks (things AI sessions left them to do, decide or answer) in priority order. You answer with a JSON array only.'
const TRIAGE_LIMIT = 150
let isTriaging = false

/** Runs a triage pass when one is due (or `force`), claiming the shared doc so only one session runs it. */
async function maybeTriage($: EngineInterface, force: boolean): Promise<string> {
  if (isTriaging) return 'A triage pass is already running in this session.'
  if (await read($, offAtom)) return OFF_TEXT
  isTriaging = true
  try {
    const open = await refresh($)
    const now = await $.clock.now()
    const meta = await readTriageMeta($, url)
    if (open.length === 0) return 'Nothing open to triage.'
    if (meta && Date.parse(meta.runningUntil) > now) return 'Another session is triaging right now.'
    if (!force && !triageDue(open, meta, now)) return 'Not due.'
    const nowIso = new Date(now).toISOString()
    // the claim: a conflict here means another session got there first
    try {
      await writeTriageMeta($, url, meta, {
        lastRun: meta?.lastRun ?? '',
        runningUntil: new Date(now + 10 * 60_000).toISOString(),
      })
    } catch (err) {
      if (err instanceof DbError && err.isConflict) return 'Another session started a triage pass first.'
      throw err
    }
    const list = allAsks(open).slice(0, TRIAGE_LIMIT)
    if (open.length > TRIAGE_LIMIT) $.ui.log(`${PLUGIN}: triage left out ${open.length - TRIAGE_LIMIT} asks past the first ${TRIAGE_LIMIT}`, { to: 'debug' })
    const lines = list.map(a =>
      JSON.stringify({
        id: a.id,
        text: a.text,
        kind: a.kind,
        urgency: a.urgency,
        ignorable: a.ignorable,
        blocks: a.blocks,
        asked: a.createdAt.slice(0, 16),
        where: [a.folderName, a.sessionName].filter(Boolean).join(' / '),
        triaged: a.triagedAt !== null,
      }),
    )
    const prompt = `Now: ${nowIso}

Open asks, one JSON object per line (current guesses; "triaged": false means new since the last pass):
${lines.join('\n')}

Re-judge each ask and put the whole list in the order the person should deal with them, most important first:
- urgency is about time: "now" if it matters today or something is waiting on it right now, "soon" for this week, "later" if there is no clock. Dates in the text and the ask's age count: a deadline coming closer moves it up.
- ignorable is about consequence: true only if nothing real is tied to it, blocked on it or half done, so it could sit forever without harm. Half-done work and anything blocking other work is never ignorable.
- blocks: what it blocks, is tied to, or what is half done ("" when ignorable).
- New asks that matter more than older ones go above them.
Answer with a JSON array of every id, in order: [{"id", "urgency", "ignorable", "blocks"}].`
    const r = await $.model.complete({
      model: 'sonnet',
      system: TRIAGE_SYSTEM,
      prompt,
      maxTokens: 120 * list.length + 200,
      effort: 'low',
      timeoutMs: 180_000,
    })
    let changed = 0
    if (r.isAnswered) {
      // asks closed or edited since the read fail their version pin; the next pass gets them
      const changes = triageChanges(r.text, list, nowIso)
      changed = changes.length
      await writeTriage($, url, changes).catch(err => fail($, 'triage write failed', err))
    } else {
      $.ui.log(`${PLUGIN}: triage got no answer (${r.reason})`, { to: 'debug' })
    }
    const after = await readTriageMeta($, url)
    await writeTriageMeta($, url, after, { lastRun: r.isAnswered ? nowIso : (meta?.lastRun ?? ''), runningUntil: '' })
    await refresh($)
    return r.isAnswered ? `Triaged ${list.length} q's; ${changed} changed.` : `Triage got no answer (${r.reason}).`
  } catch (err) {
    fail($, 'triage failed', err)
    return `Triage failed: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    isTriaging = false
  }
}


async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: "Q's" })
  void refreshQuietly($)
}



export const register: Register = (on, rawOptions) => {
  const options: Options = {
    artifactUrl:
      typeof rawOptions.artifactUrl === 'string' && rawOptions.artifactUrl.trim() !== ''
        ? rawOptions.artifactUrl.trim()
        : DEFAULT_URL,
    sweep: rawOptions.sweep !== false,
  }
  url = options.artifactUrl

  // ---- session start: tools, command, timer ------------------------------

  on('session.start', async ($, e, next) => {
    TOOL.add = (await $.tool.register({
      name: 'qs_add',
      description:
        "File one thing the user has to do, decide or answer, so it lands on their q's list. One call per item; short imperative text that stands on its own.",
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Short imperative, self-contained (names the thing it is about).' },
          kind: { type: 'string', enum: ['do', 'decide', 'answer'] },
          urgency: {
            type: 'string',
            enum: ['now', 'soon', 'later'],
            description: 'Time: now (today, or something waits on it), soon (this week), later (no clock). Always guess.',
          },
          ignorable: {
            type: 'boolean',
            description: 'True only if nothing real is tied to it, blocked on it or half done. Always guess.',
          },
          blocks: {
            type: 'string',
            description: 'What it blocks, is tied to, or what is half done. Empty when ignorable.',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 3,
            description:
              'Reply buttons when the user\'s part is just picking or approving, e.g. ["Push", "Not yet"]. Their click comes back to this session as a message. Include them whenever there is a simple action to approve.',
          },
        },
        required: ['text', 'kind', 'urgency', 'ignorable'],
      },
      isDeferred: false,
    })).tool
    TOOL.resolve = (await $.tool.register({
      name: 'qs_resolve',
      description: 'Close an ask once the user did it or answered it (done), or it no longer applies (dismissed).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The id qs_add or qs_list gave.' },
          status: { type: 'string', enum: ['done', 'dismissed'] },
        },
        required: ['id', 'status'],
      },
      isDeferred: false,
    })).tool
    TOOL.list = (await $.tool.register({
      name: 'qs_list',
      description: "List the user's open q's with their ids: this session's (default), this folder's, or all.",
      inputSchema: {
        type: 'object',
        properties: { scope: { type: 'string', enum: ['session', 'folder', 'all'] } },
      },
      isDeferred: false,
    })).tool
    await $.command.register({
      name: 'qs',
      description: "Show the things Claude left for you (q's); /qs done|dismiss <n>, /qs triage, /qs off|on",
      argumentHint: '[done <n> | dismiss <n> | triage | off | on]',
    })
    // answers picked on the phone page reach this conversation within a minute
    $.clock.every(60_000, () => void deliverAnswers($).catch(err => fail($, 'delivering answers failed', err)))
    $.clock.after(5_000, () => void deliverAnswers($).catch(err => fail($, 'delivering answers failed', err)))
    $.clock.every(60_000, () => {
      void $.ui
        .panes()
        .then(panes => (panes.some(p => p.id === PANE) ? refresh($) : undefined))
        .catch(err => fail($, 'timed refresh failed', err))
    })
    $.clock.after(0, () => void refreshQuietly($))
    // the re-ranking pass: checked every 30 minutes, runs when due (see triageDue)
    $.clock.every(30 * 60_000, () => void maybeTriage($, false))
    $.clock.after(60_000, () => void maybeTriage($, false))
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    await keepTitle($, e.session_title)
    return next(e)
  })
    .catch(($, e, next) => next(e))
  on('classic.UserPromptSubmit', async ($, e, next) => {
    await keepTitle($, e.session_title)
    return next(e)
  })
    .catch(($, e, next) => next(e))

  // ---- the system prompt -------------------------------------------------

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (await read($, offAtom)) return composed
    return {
      ...composed,
      sections: [...composed.sections, { id: `${PLUGIN}:qs`, text: promptSection(), scope: 'session' as const }],
    }
  })

  // ---- the model's tools ---------------------------------------------------

  on('tool.call', { tool: MATCH.add }, async ($, e) => {
    if (await read($, offAtom)) return { result: OFF_TEXT }
    const input = e as unknown as { text?: unknown; kind?: unknown; urgency?: unknown; ignorable?: unknown; blocks?: unknown; options?: unknown }
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    const kind: AskKind = input.kind === 'decide' || input.kind === 'answer' ? input.kind : 'do'
    if (!text) return { result: 'Nothing filed: text is empty.' }
    const here = await locate($)
    const dup = sessionAsks(await read($, asksAtom), here).find(a => same(a.text, text))
    if (dup) return { result: `Already open as ${dup.id}; not filed again.` }
    try {
      const ask = await fileAsk($, text, kind, judged(input), 'tool', cleanOptions(input.options))
      return { result: `Filed ${ask.id} (${kind}, ${ask.urgency}${ask.ignorable ? ', ignorable' : ''}).` }
    } catch (err) {
      fail($, 'qs_add failed', err)
      return { result: `Could not file it: ${err instanceof Error ? err.message : String(err)}` }
    }
  }).catch(() => ({ result: "The q's tool failed; see the debug log." }))

  on('tool.call', { tool: MATCH.resolve }, async ($, e) => {
    if (await read($, offAtom)) return { result: OFF_TEXT }
    const input = e as unknown as { id?: unknown; status?: unknown }
    const id = typeof input.id === 'string' ? input.id.trim() : ''
    const status = input.status === 'dismissed' ? 'dismissed' : 'done'
    let ask = (await read($, asksAtom)).find(a => a.id === id)
    try {
      if (!ask) ask = (await refresh($)).find(a => a.id === id)
      if (!ask) return { result: `No open ask with id ${id}.` }
      await resolveAsk($, ask, status, 'session')
      return { result: `Marked ${id} ${status}.` }
    } catch (err) {
      fail($, 'qs_resolve failed', err)
      return { result: `Could not close it: ${err instanceof Error ? err.message : String(err)}` }
    }
  }).catch(() => ({ result: "The q's tool failed; see the debug log." }))

  on('tool.call', { tool: MATCH.list }, async ($, e) => {
    if (await read($, offAtom)) return { result: OFF_TEXT }
    const scope = (e as unknown as { scope?: unknown }).scope
    let open: Ask[]
    try {
      open = await refresh($)
    } catch (err) {
      fail($, 'qs_list failed', err)
      open = await read($, asksAtom)
    }
    const here = await read($, hereAtom)
    const shown =
      scope === 'all'
        ? allAsks(open)
        : scope === 'folder'
          ? folderAsks(open, here)
          : sessionAsks(open, here)
    if (shown.length === 0) return { result: "No open q's." }
    const lines = shown.map(
      a =>
        `${a.id} · ${a.urgency}${a.ignorable ? ' · ignorable' : ''} · ${a.kind} · ${a.text}` +
        (a.blocks ? ` [blocks: ${a.blocks}]` : '') +
        (scope === 'session' || scope === undefined ? '' : ` (${a.folderName || a.folder})`),
    )
    return { result: lines.join('\n') }
  }).catch(() => ({ result: "The q's tool failed; see the debug log." }))

  // ---- turns: refresh, and the safety-net sweep ---------------------------

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) $.clock.after(0, () => void refreshQuietly($))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const isOff = await read($, offAtom)
    const answer = e.answer
    const wantsSweep = !isOff && options.sweep && e.reason === 'answer' && mightHoldAsks(answer)
    $.clock.after(0, () => {
      void (wantsSweep ? sweep($, answer) : refresh($)).catch(err => fail($, 'after-turn work failed', err))
    })
    return next(e)
  })

  // ---- /qs ---------------------------------------------------------------

  on('command.run', { command: 'qs' }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (verb === '') {
      await openPane($)
      return { text: "Q's pane opened." }
    }
    if (verb === 'off' || verb === 'on') {
      await update($, offAtom, () => verb === 'off')
      return {
        text:
          verb === 'off'
            ? "Q's capture is off in this session: no prompt section, no sweep, no band."
            : "Q's capture is on in this session.",
      }
    }
    if (verb === 'done' || verb === 'dismiss') {
      const n = Number(arg)
      const here = await locate($)
      const mine = sessionAsks(await read($, asksAtom), here)
      const ask = Number.isInteger(n) ? mine[n - 1] : undefined
      if (!ask) return { text: `No ask number ${arg || '?'} in this session (it has ${mine.length} open).` }
      try {
        await resolveAsk($, ask, verb === 'done' ? 'done' : 'dismissed', 'session')
        return { text: `${verb === 'done' ? 'Done' : 'Dismissed'}: ${ask.text}` }
      } catch (err) {
        fail($, `/qs ${verb} failed`, err)
        return { text: `Could not change it: ${err instanceof Error ? err.message : String(err)}` }
      }
    }
    if (verb === 'triage') return { text: await maybeTriage($, true) }
    return { text: 'Usage: /qs  |  /qs done <n>  |  /qs dismiss <n>  |  /qs triage  |  /qs off  |  /qs on' }
  })

  // ---- the band above the prompt ---------------------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, offAtom))) return next(e)
    const line = bandText(await read($, asksAtom), await read($, hereAtom))
    if (!line) return next(e)
    const { Box, Button } = $.ui.resolve(e)
    return (
      <Box>
        <Button key="qs-band" plain onPress={() => openPane($)}>
          {line}
        </Button>
      </Box>
    )
  })

  // ---- the pane ------------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const tab = await read($, tabAtom)
    const asks = await read($, asksAtom)
    const here = await read($, hereAtom)
    const error = await read($, errorAtom)
    const isOff = await read($, offAtom)
    const now = Date.now()

    const mine = sessionAsks(asks, here)
    const numbers = new Map(mine.map((a, i) => [a.id, i + 1]))
    const shown = tab === 'session' ? mine : tab === 'folder' ? folderAsks(asks, here) : allAsks(asks)
    const where = (a: Ask) =>
      [tab === 'all' ? a.folderName || a.folder : '', a.sessionId === here?.sessionId ? 'this session' : a.sessionName || `session ${a.sessionId.slice(0, 8)}`]
        .filter(Boolean)
        .join(' · ')

    const setTab = (t: AskTab) => () => update($, tabAtom, () => t)
    const pick = (a: Ask, answer: string) => async () => {
      try {
        await answerAsk($, a, answer)
      } catch (err) {
        fail($, 'answering from the pane failed', err)
      }
      void refreshQuietly($)
    }
    const act = (a: Ask, status: 'done' | 'dismissed') => async () => {
      try {
        await resolveAsk($, a, status, 'pane')
      } catch (err) {
        fail($, 'closing from the pane failed', err)
      }
      void refreshQuietly($)
    }
    const tabButton = (t: AskTab, label: string) => (
      <Button key={`tab:${t}`} label={tab === t ? `${label} *` : label} variant={tab === t ? 'primary' : 'secondary'} onPress={setTab(t)} />
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          {tabButton('session', `Session ${mine.length}`)}
          {tabButton('folder', `Folder ${folderAsks(asks, here).length}`)}
          {tabButton('all', `All ${asks.length}`)}
          <Button key="refresh" label="Refresh" onPress={() => void refreshQuietly($)} />
        </Box>
        {isOff && <Text dimColor>Capture is off in this session (/qs on).</Text>}
        {error !== '' && <Text color="red">{error}</Text>}
        {shown.length === 0 && <Text dimColor>Nothing open here.</Text>}
        <Box flexDirection="column" gap={1} marginTop={1}>
        {shown.map(a => (
          <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
            <Text wrap="wrap" dimColor={a.ignorable}>
              {numbers.has(a.id) ? `${numbers.get(a.id)}. ` : '   '}
              <Text color={a.urgency === 'now' ? 'red' : a.urgency === 'soon' ? 'yellow' : 'gray'}>{a.urgency}</Text>{' '}
              <Text color={a.kind === 'do' ? 'cyan' : a.kind === 'decide' ? 'magenta' : 'yellow'}>[{a.kind}]</Text>{' '}
              {a.text} <Text dimColor>{age(a.createdAt, now)}</Text>
            </Text>
            <Text dimColor wrap="wrap">
              {'   '}
              {[a.ignorable ? 'ignorable' : a.blocks ? `blocks: ${a.blocks}` : '', where(a)].filter(Boolean).join(' · ')}
            </Text>
            <Box flexDirection="row" gap={1}>
              {a.options.length > 0 ? (
                a.options.map((o, i) => <Button key={`answer:${a.id}:${i}`} label={o} variant="primary" onPress={pick(a, o)} />)
              ) : (
                <Button key={`done:${a.id}`} label="Done" onPress={act(a, 'done')} />
              )}
              <Button key={`dismiss:${a.id}`} label="Dismiss" onPress={act(a, 'dismissed')} />
            </Box>
          </Box>
        ))}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>On your phone: {url}</Text>
        </Box>
      </Box>
    )
  })
}
