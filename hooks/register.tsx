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
  cleanGroup,
  cleanOptions,
  cleanStep,
  markDelivered,
  mightHoldAsks,
  nameFromPrompt,
  readUndelivered,
  newId,
  parseSweepReply,
  readAll,
  readOpen,
  readTriageMeta,
  sessionAsks,
  sessionLabel,
  TEXT_MAX,
  titleFromTranscript,
  triageChanges,
  triageDue,
  writeChanges,
  writeChangesMeta,
} from './db'

const PLUGIN = 'qs'
const PANE = 'qs'
const OFF_TEXT = "Q's capture is off in this session (turn it on with /qs on)."
const NOT_SET_UP = "Q's isn't set up yet: ask the user to run /qs setup, which makes their private list page."
const URL_PATTERN = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/

const asksAtom = atom({ plugin: 'qs', key: 'asks' } as const, [])
const hereAtom = atom({ plugin: 'qs', key: 'here' } as const, null)
const offAtom = atom({ plugin: 'qs', key: 'isOff' } as const, false)
const tabAtom = atom({ plugin: 'qs', key: 'tab' } as const, 'session')
const titleAtom = atom({ plugin: 'qs', key: 'title' } as const, '')
const errorAtom = atom({ plugin: 'qs', key: 'error' } as const, '')

// The full names are mcp__<server>__qs_*, where the server name is the engine's (it can lag a
// rename), so hooks match on the ending and the prompt names what tool.register reported.
const TOOL = { add: 'qs_add', resolve: 'qs_resolve', list: 'qs_list', order: 'qs_order' }
const MATCH = { add: /__qs_add$/, resolve: /__qs_resolve$/, list: /__qs_list$/, order: /__qs_order$/ }

const promptSection = () => `# Q's for the user (qs mod)
Whenever a reply leaves the user something to do, decide or answer, file each one with the \`${TOOL.add}\` tool as part of that reply: one call per item, kind "do", "decide" or "answer". Each q has two parts:
- text: the title the user skims in a list. 5-10 words, imperative, naming the thing it is about ("Approve pushing acme-api v2.3"). At most ${TEXT_MAX} characters; longer is refused. No reasons, steps, paths or commands here.
- detail: everything else, written for someone who has forgotten this conversation: what it refers to (repo, file, server, site), why it is needed, and any link, path or command the user needs to act on it. One to three sentences.
Every ask needs your best guess at two things, even when unsure:
- urgency (time): "now" if it matters today or something is waiting on it right now, "soon" for this week, "later" if there is no clock on it.
- ignorable: true only if nothing real is tied to it, blocked on it or half done, so it could sit forever without harm. When false, say in blocks what it blocks, is tied to, or what is half done.
- options: when the user's part is just clicking a button (approve a push or deploy, pick A or B, yes/no), give the 2-3 short button labels, e.g. ["Push", "Not yet"]. Their click comes back to this session as a message; then do what it says.
When several q's belong to one task, or must be done in a set order (steps of a fix, things to try in turn), give them the same group (a short kebab-case tag for the task, e.g. "router-swap") and step numbers 1, 2, 3 in the order the user should do them; they are then listed together in that order. To group or reorder q's already filed, call \`${TOOL.order}\` with their ids in order.
Don't file what you will do yourself, and don't file generic offers like "let me know if you want more".
Keeping the list clean is your job, not the user's: they should never have to ask you to clear q's. In the same turn that any of these happens, close the q with \`${TOOL.resolve}\` without being asked: the user says they did it, answers it or decides it (status "done"); you did it yourself, or your work made it unnecessary; the plan changed and it no longer applies ("dismissed"); a newer q replaces it ("dismissed", then file the new one). Each user message comes with a note of this session's open q's and their ids: check it against what the user just said and what you did this turn.
Don't re-file an item that is still open: check \`${TOOL.list}\` (this session's open q's with their ids) when unsure.`

const SWEEP_SYSTEM =
  "You keep a list of what an assistant leaves for the USER to do, decide or answer: you spot new items in its latest reply, and open items the latest exchange settled. You answer with one JSON object only."

/** The note a user message carries while this session has open q's, so the model closes what the turn settles. */
const openNote = (mine: readonly Ask[]) => `q's still open from this session (qs mod):
${mine.slice(0, 20).map(a => `- ${a.id} · ${a.text}`).join('\n')}
If this message says any of them is done, answered, decided or no longer needed, or your work this turn settles one, close it with \`${TOOL.resolve}\` in this turn, without being asked. Leave the rest, and don't mention this note.`

type Options = { artifactUrl: string; sweep: boolean }

// Set by register (which runs again on every load) and /qs setup, read by the helpers below.
// '' until the person has a list page: then nothing is read, filed or shown but the setup hint.
let url = ''
const STORE_URL = 'artifactUrl'
// The session's name from its first prompt, for sessions the engine reports no title for.
let promptName = ''
// This session's transcript file (from the classic hook events) and the last title read from it.
let transcriptPath = ''
let transcriptName = ''

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
  if (!url) return []
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
  more: { group?: string; step?: number | null; detail?: string } = {},
): Promise<Ask> {
  if (!url) throw new Error(NOT_SET_UP)
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
    detail: (more.detail ?? '').trim(),
    kind,
    status: 'open',
    folder: here.folder,
    folderName: baseName(here.folder),
    sessionId: here.sessionId,
    sessionName: await sessionName($),
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
    group: more.group ?? '',
    step: more.step ?? null,
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
  if (!url || isDelivering || (await read($, offAtom))) return
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


const TITLE_LINES = '"(customTitle|aiTitle)":"([^"\\\\]|\\\\.)*"'

// The session's title, where the engine reports one, and where its transcript is kept.
const keepTitle = async ($: EngineInterface, e: { session_title?: unknown; transcript_path?: unknown }) => {
  if (typeof e.transcript_path === 'string' && e.transcript_path) transcriptPath = e.transcript_path
  const title = e.session_title
  if (typeof title === 'string' && title.trim() !== '') await update($, titleAtom, () => title.trim())
  await syncName($)
}

/** Renames this session's open q's when its name has changed (a title arrived, or was edited). */
async function syncName($: EngineInterface) {
  const here = await read($, hereAtom)
  if (!url || !here) return
  const mine = (await read($, asksAtom)).filter(a => a.sessionId === here.sessionId)
  if (mine.length === 0) return
  const name = await sessionName($)
  const stale = mine.filter(a => a.sessionName !== name)
  if (!name || stale.length === 0) return
  await writeChanges($, url, stale.map(ask => ({ ask, data: { sessionName: name } })))
    .then(() => refresh($))
    .catch(err => fail($, 'renaming the session on its q\'s failed', err))
}

/**
 * The title in this session's transcript: the name the person gave it, else the one Claude Code
 * generated (which the hook events don't carry). The last one found is kept when a read fails.
 */
async function transcriptTitle($: EngineInterface): Promise<string> {
  if (!transcriptPath) return transcriptName
  try {
    const found = await $.process.run(['grep', '-oE', TITLE_LINES, transcriptPath], { timeoutMs: 10_000 })
    transcriptName = titleFromTranscript(found.stdout) || transcriptName
  } catch {
    // no transcript yet, or no grep: the earlier name stands
  }
  return transcriptName
}

/** The session's name: its title (given or generated), else a short name from its first prompt; never its id. */
async function sessionName($: EngineInterface): Promise<string> {
  const title = (await read($, titleAtom)) || (await transcriptTitle($))
  if (title) return title
  if (!promptName) {
    try {
      const first = (await $.session.messages()).find(
        m => m.role === 'user' && !/^This session is being continued/.test(m.text) && nameFromPrompt(m.text) !== '',
      )
      promptName = first ? nameFromPrompt(first.text) : ''
    } catch {
      promptName = ''
    }
  }
  return promptName
}

/**
 * Puts each session's title on its q's: those filed before sessions had names, and those named
 * from a first prompt before the session had a title. Titles come from the saved transcripts
 * under the Claude config folder. Returns a line for the person.
 */
async function nameOldSessions($: EngineInterface): Promise<string> {
  const all = (await readAll($, url)).filter(a => a.sessionId)
  const home = await $.process.run(['sh', '-c', 'printf %s "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"'])
  const projects = `${home.stdout.trim()}/projects`
  const changes: { ask: Ask; data: Record<string, unknown> }[] = []
  let missing = 0
  for (const sessionId of new Set(all.map(a => a.sessionId))) {
    if (!/^[\w-]+$/.test(sessionId)) continue
    const found = await $.process.run(['grep', '-rhoE', '--include', `${sessionId}.jsonl`, TITLE_LINES, projects], {
      timeoutMs: 60_000,
    })
    const name = titleFromTranscript(found.stdout)
    const asks = all.filter(a => a.sessionId === sessionId)
    if (!name) missing += asks.filter(a => !a.sessionName).length
    else for (const ask of asks) if (ask.sessionName !== name) changes.push({ ask, data: { sessionName: name } })
  }
  if (changes.length > 0) await writeChanges($, url, changes)
  await refresh($)
  const left = missing ? ` ${missing} left as "session from <date>": no title found on this computer.` : ''
  return changes.length === 0 && !missing
    ? "Every q already has its session's title."
    : `Named ${changes.length} q's from their sessions' titles.${left}`
}

/**
 * The after-turn safety net, one small-model call: closes this session's open q's that the
 * last exchange settled, and files what the reply left for the user that nobody filed.
 */
async function sweep($: EngineInterface, answer: string) {
  const open = await refresh($).catch(() => read($, asksAtom))
  const here = await read($, hereAtom)
  const mine = sessionAsks(open, here)
  const filed = mine.map(a => `- ${a.id} (${a.kind}) ${a.text}${a.detail ? ` — ${a.detail.slice(0, 200)}` : ''}`).join('\n')
  let said = ''
  try {
    said = (await $.session.messages()).filter(m => m.role === 'user').at(-1)?.text ?? ''
  } catch {
    said = ''
  }
  const prompt = `The user's last message:
<<<
${said.slice(-2000) || '(not available)'}
>>>

The assistant's reply to it:
<<<
${answer.slice(-6000)}
>>>

Open items, already on the user's list:
${filed || '(none)'}

Answer with one JSON object: {"close": [...], "file": [...]}.
"close": the open items this exchange settled. An item is settled only when the user's message or the reply says plainly that it was done, answered, decided, or no longer applies (the plan changed, something replaced it). Each: {"id", "status": "done" | "dismissed" (no longer applies)}. When unsure, leave it open: a wrong close hides something the user still has to do.
"file": each thing the reply leaves the USER to do, decide or answer that is NOT already an open item (the same meaning counts as filed). Skip what the assistant will do itself, and generic offers ("let me know if..."). Each: {"text": a title to skim, 5-10 words, imperative, naming the thing it is about, at most ${TEXT_MAX} characters, "detail": one to three sentences for someone who has forgotten the conversation: what it refers to, why, and any link, path or command from the reply needed to act on it, "options": 2-3 short button labels when the user's part is just picking or approving (e.g. ["Push", "Not yet"]), else [], "kind": "do" | "decide" | "answer", "urgency": "now" (today, or something waits on it) | "soon" (this week) | "later" (no clock), "ignorable": true only if nothing real is tied to it, blocked on it or half done, "blocks": what it blocks or what is half done ("" when ignorable)}. Always guess urgency and ignorable.
Both lists are [] when there is nothing.`
  const r = await $.model.complete({
    model: 'haiku',
    system: SWEEP_SYSTEM,
    prompt,
    maxTokens: 1200,
    effort: 'low',
    timeoutMs: 45_000,
  })
  if (!r.isAnswered) {
    $.ui.log(`${PLUGIN}: sweep got no answer (${r.reason})`, { to: 'debug' })
    return
  }
  const { found, closed } = parseSweepReply(r.text, mine.map(a => a.id))
  let closedCount = 0
  for (const c of closed) {
    // only what is still open: the model may have closed it itself while this ran
    const ask = (await read($, asksAtom)).find(a => a.id === c.id)
    if (!ask) continue
    try {
      await resolveAsk($, ask, c.status, 'sweep')
      closedCount++
    } catch (err) {
      if (!(err instanceof DbError && err.isConflict)) fail($, 'closing a settled q failed', err)
    }
  }
  if (closedCount > 0) $.ui.toast(`q's: closed ${closedCount} that this turn settled`)
  const now = sessionAsks(await read($, asksAtom), here)
  for (const item of found) {
    if (now.some(a => same(a.text, item.text))) continue
    await fileAsk($, item.text, item.kind, item, 'sweep', item.options, { detail: item.detail })
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
  if (!url) return NOT_SET_UP
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
      await writeChangesMeta($, url, meta, {
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
        ...(a.detail ? { detail: a.detail.slice(0, 200) } : {}),
        kind: a.kind,
        urgency: a.urgency,
        ignorable: a.ignorable,
        blocks: a.blocks,
        asked: a.createdAt.slice(0, 16),
        where: [a.folderName, a.sessionName].filter(Boolean).join(' / '),
        ...(a.group ? { group: a.group, step: a.step } : {}),
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
- Asks sharing a "group" are steps of one task, always shown together in step order: judge them together.
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
      await writeChanges($, url, changes).catch(err => fail($, 'triage write failed', err))
    } else {
      $.ui.log(`${PLUGIN}: triage got no answer (${r.reason})`, { to: 'debug' })
    }
    const after = await readTriageMeta($, url)
    await writeChangesMeta($, url, after, { lastRun: r.isAnswered ? nowIso : (meta?.lastRun ?? ''), runningUntil: '' })
    await refresh($)
    return r.isAnswered ? `Triaged ${list.length} q's; ${changed} changed.` : `Triage got no answer (${r.reason}).`
  } catch (err) {
    fail($, 'triage failed', err)
    return `Triage failed: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    isTriaging = false
  }
}


/**
 * /qs setup: with a link, use that page; without one, publish this mod's page/asks.html as the
 * person's own private page (it keeps the list in its db). Remembered across sessions.
 */
async function setup($: EngineInterface, arg: string): Promise<string> {
  if (arg) {
    const link = URL_PATTERN.exec(arg)?.[0]
    if (!link) return 'That isn\'t a claude.ai artifact link (https://claude.ai/artifact/...).'
    return useUrl($, link, `Using ${link} for your q's.`)
  }
  if (url) return `Already set up: ${url}. To use another page: /qs setup <its link>.`
  const page = `${$.plugin.root}/page/asks.html`
  const manual = `Or ask Claude to publish ${page} as an Artifact with the db capability, then run /qs setup <its link>.`
  let text = ''
  try {
    const ran = await $.tool.call({
      tool: 'Artifact',
      action: 'publish',
      file_path: page,
      icon: 'list',
      description: "The things Claude sessions left you to do, decide or answer.",
      capabilities: { db: {} },
    } as never)
    if (ran.deny !== undefined) return `Making the page was refused: ${ran.deny}. ${manual}`
    text = typeof ran.text === 'string' ? ran.text : typeof ran.result === 'string' ? ran.result : JSON.stringify(ran.result ?? '')
  } catch (err) {
    return `Making the page failed: ${err instanceof Error ? err.message : String(err)}. ${manual}`
  }
  const link = URL_PATTERN.exec(text)?.[0]
  if (!link) return `Making the page didn't give a link back (${text.slice(0, 200)}). ${manual}`
  return useUrl($, link, `Made your private q's page: ${link}. Open it on your phone to tick things off.`)
}

async function useUrl($: EngineInterface, link: string, done: string): Promise<string> {
  url = link
  // kept for later sessions; this one uses it either way
  await $.store.set(STORE_URL, link).catch(err => fail($, 'saving the page link failed', err))
  await refreshQuietly($)
  return done
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: "Q's" })
  void refreshQuietly($)
}



export const register: Register = (on, rawOptions) => {
  const options: Options = {
    artifactUrl: typeof rawOptions.artifactUrl === 'string' ? rawOptions.artifactUrl.trim() : '',
    sweep: rawOptions.sweep !== false,
  }
  // the setting wins; else the page /qs setup made (read at session start)
  url = options.artifactUrl

  // ---- session start: tools, command, timer ------------------------------

  on('session.start', async ($, e, next) => {
    if (!url) {
      const stored = await $.store.get(STORE_URL).catch(() => undefined)
      if (typeof stored === 'string') url = stored
    }
    TOOL.add = (await $.tool.register({
      name: 'qs_add',
      description:
        "File one thing the user has to do, decide or answer, so it lands on their q's list. One call per item; short imperative text that stands on its own.",
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: `The title the user skims: 5-10 words, imperative, naming the thing it is about. At most ${TEXT_MAX} characters (longer is refused); no reasons, steps, paths or commands.`,
          },
          detail: {
            type: 'string',
            description:
              'The context, for someone who has forgotten this conversation: what it refers to (repo, file, server, site), why it is needed, and any link, path or command needed to act on it. One to three sentences.',
          },
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
          group: {
            type: 'string',
            description:
              'Optional short kebab-case tag shared by q\'s that belong to one task, e.g. "router-swap". Grouped q\'s are listed together.',
          },
          step: {
            type: 'integer',
            minimum: 1,
            description: 'Optional place within its group (1 = do first). Use with group when the order matters.',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 3,
            description:
              'Reply buttons when the user\'s part is just picking or approving, e.g. ["Push", "Not yet"]. Their click comes back to this session as a message. Include them whenever there is a simple action to approve.',
          },
        },
        required: ['text', 'detail', 'kind', 'urgency', 'ignorable'],
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
    TOOL.order = (await $.tool.register({
      name: 'qs_order',
      description:
        "Group open q's that belong to one task and set the order to do them in: pass their ids in that order. They get the group and steps 1, 2, 3...",
      inputSchema: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Open q ids, first to do first.' },
          group: { type: 'string', description: 'Short kebab-case tag for the task, e.g. "router-swap".' },
        },
        required: ['ids', 'group'],
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
      description: "Show the things Claude left for you (q's); /qs setup, /qs done|dismiss <n>, /qs triage, /qs names, /qs off|on",
      argumentHint: '[setup [url] | done <n> | dismiss <n> | triage | names | off | on]',
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
    await keepTitle($, e)
    return next(e)
  })
    .catch(($, e, next) => next(e))
  // each user message carries this session's open q's, so the model closes what the turn settles
  on('classic.UserPromptSubmit', async ($, e, next) => {
    await keepTitle($, e)
    const result = await next(e)
    if (!url || (await read($, offAtom))) return result
    const mine = sessionAsks(await read($, asksAtom), await read($, hereAtom))
    if (mine.length === 0) return result
    return { ...result, additionalContext: [...(result.additionalContext ?? []), openNote(mine)] }
  })
    .catch(($, e, next) => next(e))

  // ---- the system prompt -------------------------------------------------

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!url || (await read($, offAtom))) return composed
    return {
      ...composed,
      sections: [...composed.sections, { id: `${PLUGIN}:qs`, text: promptSection(), scope: 'session' as const }],
    }
  })

  // ---- the model's tools ---------------------------------------------------

  on('tool.call', { tool: MATCH.add }, async ($, e) => {
    if (await read($, offAtom)) return { result: OFF_TEXT }
    if (!url) return { result: NOT_SET_UP }
    const input = e as unknown as {
      text?: unknown
      detail?: unknown
      kind?: unknown
      urgency?: unknown
      ignorable?: unknown
      blocks?: unknown
      options?: unknown
      group?: unknown
      step?: unknown
    }
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    const kind: AskKind = input.kind === 'decide' || input.kind === 'answer' ? input.kind : 'do'
    if (!text) return { result: 'Nothing filed: text is empty.' }
    if (text.length > TEXT_MAX) {
      return {
        result: `Nothing filed: text is ${text.length} characters. It is the title the user skims: cut it to 5-10 words (${TEXT_MAX} characters at most) and move the rest into detail, then call again.`,
      }
    }
    const detail = typeof input.detail === 'string' ? input.detail.trim().slice(0, 1500) : ''
    const here = await locate($)
    const dup = sessionAsks(await read($, asksAtom), here).find(a => same(a.text, text))
    if (dup) return { result: `Already open as ${dup.id}; not filed again.` }
    try {
      const group = cleanGroup(input.group)
      const place = { group, step: group ? cleanStep(input.step) : null, detail }
      const ask = await fileAsk($, text, kind, judged(input), 'tool', cleanOptions(input.options), place)
      const where = group ? `, ${group}${ask.step ? ` step ${ask.step}` : ''}` : ''
      return { result: `Filed ${ask.id} (${kind}, ${ask.urgency}${ask.ignorable ? ', ignorable' : ''}${where}).` }
    } catch (err) {
      fail($, 'qs_add failed', err)
      return { result: `Could not file it: ${err instanceof Error ? err.message : String(err)}` }
    }
  }).catch(() => ({ result: "The q's tool failed; see the debug log." }))

  on('tool.call', { tool: MATCH.resolve }, async ($, e) => {
    if (await read($, offAtom)) return { result: OFF_TEXT }
    if (!url) return { result: NOT_SET_UP }
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

  on('tool.call', { tool: MATCH.order }, async ($, e) => {
    if (await read($, offAtom)) return { result: OFF_TEXT }
    if (!url) return { result: NOT_SET_UP }
    const input = e as unknown as { ids?: unknown; group?: unknown }
    const ids = Array.isArray(input.ids) ? input.ids.filter((x): x is string => typeof x === 'string').map(x => x.trim()) : []
    const group = cleanGroup(input.group)
    if (!group) return { result: 'Nothing changed: group is empty.' }
    try {
      const open = await refresh($)
      const missing = ids.filter(id => !open.some(a => a.id === id))
      if (missing.length) return { result: `Nothing changed: no open q with id ${missing.join(', ')}.` }
      const asks = ids.map(id => open.find(a => a.id === id)!)
      await writeChanges($, url, asks.map((ask, i) => ({ ask, data: { group, step: i + 1 } })))
      await refresh($)
      return { result: `Grouped ${asks.length} q's as ${group}, in that order.` }
    } catch (err) {
      fail($, 'qs_order failed', err)
      return { result: `Could not reorder: ${err instanceof Error ? err.message : String(err)}` }
    }
  }).catch(() => ({ result: "The q's tool failed; see the debug log." }))

  on('tool.call', { tool: MATCH.list }, async ($, e) => {
    if (await read($, offAtom)) return { result: OFF_TEXT }
    if (!url) return { result: NOT_SET_UP }
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
        `${a.id} · ${a.urgency}${a.ignorable ? ' · ignorable' : ''} · ${a.kind}` +
        (a.group ? ` · ${a.group}${a.step ? ` #${a.step}` : ''}` : '') +
        ` · ${a.text}` +
        (a.detail ? ` — ${a.detail.slice(0, 200)}` : '') +
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
    // worth a look when the reply may leave something, or this session has q's the turn may have settled
    const hasOpen = sessionAsks(await read($, asksAtom), await read($, hereAtom)).length > 0
    const wantsSweep = !isOff && options.sweep && e.reason === 'answer' && (hasOpen || mightHoldAsks(answer))
    $.clock.after(0, () => {
      void (wantsSweep ? sweep($, answer) : refresh($))
        .then(() => syncName($))
        .catch(err => fail($, 'after-turn work failed', err))
    })
    return next(e)
  })

  // ---- /qs ---------------------------------------------------------------

  on('command.run', { command: 'qs' }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (verb === 'setup') return { text: await setup($, e.args.trim().split(/\s+/)[1] ?? '') }
    if (!url) return { text: NOT_SET_UP.replace('ask the user to run', 'run') }
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
    if (verb === 'names') {
      try {
        return { text: await nameOldSessions($) }
      } catch (err) {
        fail($, '/qs names failed', err)
        return { text: `Could not name them: ${err instanceof Error ? err.message : String(err)}` }
      }
    }
    return { text: 'Usage: /qs  |  /qs setup [url]  |  /qs done <n>  |  /qs dismiss <n>  |  /qs triage  |  /qs names  |  /qs off  |  /qs on' }
  })

  // ---- the band above the prompt ---------------------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, offAtom))) return next(e)
    if (!url) {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box>
          <Text key="qs-band">
            📌 <Text color="white">q's: run /qs setup to make your list page</Text>
          </Text>
        </Box>
      )
    }
    const line = bandText(await read($, asksAtom), await read($, hereAtom))
    if (!line) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    // Numbers in one colour, words in another
    const parts = line.split(/(\d+)/).filter(p => p !== '')
    return (
      <Box>
        <Button key="qs-band" plain onPress={() => openPane($)}>
          📌{' '}
          {parts.map(p =>
            /^\d+$/.test(p) ? <Text color="magenta" bold>{p}</Text> : <Text color="white">{p}</Text>,
          )}
        </Button>
      </Box>
    )
  })

  // ---- the pane ------------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    if (!url) return <Text>{NOT_SET_UP.replace('ask the user to run', 'run')}</Text>
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
      [tab === 'all' ? a.folderName || a.folder : '', a.sessionId === here?.sessionId ? 'this session' : sessionLabel(a)]
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
      <Box key={`tab:${t}`} flexShrink={0}>
        <Button label={tab === t ? `${label} *` : label} variant={tab === t ? 'primary' : 'secondary'} onPress={setTab(t)} />
      </Box>
    )

    return (
      <Box flexDirection="column">
        {/* Narrow pane: whole buttons wrap to the next line instead of being squeezed */}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {tabButton('session', `Session ${mine.length}`)}
          {tabButton('folder', `Folder ${folderAsks(asks, here).length}`)}
          {tabButton('all', `All ${asks.length}`)}
          <Box key="refresh" flexShrink={0}>
            <Button label="Refresh" onPress={() => void refreshQuietly($)} />
          </Box>
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
            {a.detail !== '' && (
              <Text dimColor wrap="wrap">
                {'   '}
                {a.detail.length > 240 ? `${a.detail.slice(0, 239)}…` : a.detail}
              </Text>
            )}
            <Text dimColor wrap="wrap">
              {'   '}
              {[a.group ? `${a.group}${a.step ? ` #${a.step}` : ''}` : '', a.ignorable ? 'ignorable' : a.blocks ? `blocks: ${a.blocks}` : '', where(a)]
                .filter(Boolean)
                .join(' · ')}
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
