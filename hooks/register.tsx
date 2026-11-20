// asks (repo claude-asks): files every to-do, decision and question a session leaves for
// the person into one db (an artifact's `asks` collection), shows the count
// above the prompt and lists them in a pane opened by /asks.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ask, AskHere, AskKind, AskTab } from '../types'
import {
  age,
  bandText,
  baseName,
  close,
  create,
  folderAsks,
  mightHoldAsks,
  newId,
  parseSweep,
  readOpen,
  sessionAsks,
} from './db'

const PLUGIN = 'asks'
const PANE = 'asks'
const OFF_TEXT = 'asks capture is off in this session (turn it on with /asks on).'
const DEFAULT_URL = 'https://claude.ai/artifact/HNv6tEtKy3rXX2QzkVqRHs'

const asksAtom = atom({ plugin: 'asks', key: 'asks' } as const, [])
const hereAtom = atom({ plugin: 'asks', key: 'here' } as const, null)
const offAtom = atom({ plugin: 'asks', key: 'isOff' } as const, false)
const tabAtom = atom({ plugin: 'asks', key: 'tab' } as const, 'session')
const titleAtom = atom({ plugin: 'asks', key: 'title' } as const, '')
const errorAtom = atom({ plugin: 'asks', key: 'error' } as const, '')

const TOOL = {
  add: 'mcp__asks__asks_add',
  resolve: 'mcp__asks__asks_resolve',
  list: 'mcp__asks__asks_list',
} as const

const PROMPT_SECTION = `# Asks for the user (asks mod)
Whenever a reply leaves the user something to do, decide or answer, file each one with the \`${TOOL.add}\` tool as part of that reply: one call per item, kind "do", "decide" or "answer", and a short imperative text that makes sense on its own, away from this conversation (name the repo, file, server or thing it is about). Don't file what you will do yourself, and don't file generic offers like "let me know if you want more".
When the user says they did an item, or answers or decides it, close it with \`${TOOL.resolve}\` (status "done", or "dismissed" when it no longer applies).
Don't re-file an item that is still open: check \`${TOOL.list}\` (this session's open asks with their ids) when unsure.`

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

async function fileAsk($: EngineInterface, text: string, kind: AskKind, source: 'tool' | 'sweep'): Promise<Ask> {
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
  }
  ask.version = await create($, url, ask)
  await update($, asksAtom, list => [...list.filter(a => a.id !== ask.id), ask])
  return ask
}

async function resolveAsk($: EngineInterface, ask: Ask, status: 'done' | 'dismissed', by: string) {
  await close($, url, ask, status, by)
  await update($, asksAtom, list => list.filter(a => a.id !== ask.id))
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

List each thing this reply leaves the USER to do, decide or answer that is NOT already filed (the same meaning counts as filed). Skip what the assistant will do itself, and generic offers ("let me know if..."). Each item: {"text": short imperative that makes sense on its own, "kind": "do" | "decide" | "answer"}. Answer with a JSON array only; [] when there is nothing.`
  const r = await $.model.complete({
    model: 'haiku',
    system: SWEEP_SYSTEM,
    prompt,
    maxTokens: 500,
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
    await fileAsk($, item.text, item.kind, 'sweep')
  }
}


async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'Asks' })
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
    await $.tool.register({
      name: 'asks_add',
      description:
        'File one thing the user has to do, decide or answer, so it lands on their asks list. One call per item; short imperative text that stands on its own.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Short imperative, self-contained (names the thing it is about).' },
          kind: { type: 'string', enum: ['do', 'decide', 'answer'] },
        },
        required: ['text', 'kind'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'asks_resolve',
      description: 'Close an ask once the user did it or answered it (done), or it no longer applies (dismissed).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The id asks_add or asks_list gave.' },
          status: { type: 'string', enum: ['done', 'dismissed'] },
        },
        required: ['id', 'status'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'asks_list',
      description: "List the user's open asks with their ids: this session's (default), this folder's, or all.",
      inputSchema: {
        type: 'object',
        properties: { scope: { type: 'string', enum: ['session', 'folder', 'all'] } },
      },
      isDeferred: false,
    })
    await $.command.register({
      name: 'asks',
      description: 'Show the things Claude left for you (asks); /asks done|dismiss <n>, /asks off|on',
      argumentHint: '[done <n> | dismiss <n> | off | on]',
    })
    $.clock.every(60_000, () => {
      void $.ui
        .panes()
        .then(panes => (panes.some(p => p.id === PANE) ? refresh($) : undefined))
        .catch(err => fail($, 'timed refresh failed', err))
    })
    $.clock.after(0, () => void refreshQuietly($))
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
      sections: [...composed.sections, { id: `${PLUGIN}:asks`, text: PROMPT_SECTION, scope: 'session' as const }],
    }
  })

  // ---- the model's tools ---------------------------------------------------

  on('tool.call', { tool: 'mcp__asks__asks_add' }, async ($, e) => {
    if (await read($, offAtom)) return { result: OFF_TEXT }
    const input = e as unknown as { text?: unknown; kind?: unknown }
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    const kind: AskKind = input.kind === 'decide' || input.kind === 'answer' ? input.kind : 'do'
    if (!text) return { result: 'Nothing filed: text is empty.' }
    const here = await locate($)
    const dup = sessionAsks(await read($, asksAtom), here).find(a => same(a.text, text))
    if (dup) return { result: `Already open as ${dup.id}; not filed again.` }
    try {
      const ask = await fileAsk($, text, kind, 'tool')
      return { result: `Filed ${ask.id} (${kind}).` }
    } catch (err) {
      fail($, 'asks_add failed', err)
      return { result: `Could not file it: ${err instanceof Error ? err.message : String(err)}` }
    }
  }).catch(() => ({ result: 'The asks tool failed; see the debug log.' }))

  on('tool.call', { tool: 'mcp__asks__asks_resolve' }, async ($, e) => {
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
      fail($, 'asks_resolve failed', err)
      return { result: `Could not close it: ${err instanceof Error ? err.message : String(err)}` }
    }
  }).catch(() => ({ result: 'The asks tool failed; see the debug log.' }))

  on('tool.call', { tool: 'mcp__asks__asks_list' }, async ($, e) => {
    if (await read($, offAtom)) return { result: OFF_TEXT }
    const scope = (e as unknown as { scope?: unknown }).scope
    let open: Ask[]
    try {
      open = await refresh($)
    } catch (err) {
      fail($, 'asks_list failed', err)
      open = await read($, asksAtom)
    }
    const here = await read($, hereAtom)
    const shown =
      scope === 'all'
        ? [...open].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        : scope === 'folder'
          ? folderAsks(open, here)
          : sessionAsks(open, here)
    if (shown.length === 0) return { result: 'No open asks.' }
    const lines = shown.map(
      a => `${a.id} · ${a.kind} · ${a.text}${scope === 'session' || scope === undefined ? '' : ` (${a.folderName || a.folder})`}`,
    )
    return { result: lines.join('\n') }
  }).catch(() => ({ result: 'The asks tool failed; see the debug log.' }))

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

  // ---- /asks ---------------------------------------------------------------

  on('command.run', { command: 'asks' }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (verb === '') {
      await openPane($)
      return { text: 'Asks pane opened.' }
    }
    if (verb === 'off' || verb === 'on') {
      await update($, offAtom, () => verb === 'off')
      return {
        text:
          verb === 'off'
            ? 'Asks capture is off in this session: no prompt section, no sweep, no band.'
            : 'Asks capture is on in this session.',
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
        fail($, `/asks ${verb} failed`, err)
        return { text: `Could not change it: ${err instanceof Error ? err.message : String(err)}` }
      }
    }
    return { text: 'Usage: /asks  |  /asks done <n>  |  /asks dismiss <n>  |  /asks off  |  /asks on' }
  })

  // ---- the band above the prompt ---------------------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, offAtom))) return next(e)
    const line = bandText(await read($, asksAtom), await read($, hereAtom))
    if (!line) return next(e)
    const { Box, Button } = $.ui.resolve(e)
    return (
      <Box>
        <Button key="asks-band" plain onPress={() => openPane($)}>
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
    const shown =
      tab === 'session'
        ? mine
        : tab === 'folder'
          ? folderAsks(asks, here)
          : [...asks].sort((a, b) => b.createdAt.localeCompare(a.createdAt))

    const groups = new Map<string, Map<string, Ask[]>>()
    for (const a of shown) {
      const byFolder = groups.get(a.folder) ?? new Map<string, Ask[]>()
      groups.set(a.folder, byFolder)
      const list = byFolder.get(a.sessionId) ?? []
      byFolder.set(a.sessionId, list)
      list.push(a)
    }

    const setTab = (t: AskTab) => () => update($, tabAtom, () => t)
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
        {isOff && <Text dimColor>Capture is off in this session (/asks on).</Text>}
        {error !== '' && <Text color="red">{error}</Text>}
        {shown.length === 0 && <Text dimColor>Nothing open here.</Text>}
        {[...groups].map(([folder, sessions]) => (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{folder || '(no folder)'}</Text>
            {[...sessions].map(([sid, items]) => (
              <Box flexDirection="column">
                <Text dimColor>
                  {sid === here?.sessionId ? 'this session' : items[0]?.sessionName || `session ${sid.slice(0, 8)}`}
                </Text>
                {items.map(a => (
                  <Box flexDirection="column">
                    <Text wrap="wrap">
                      {numbers.has(a.id) ? `${numbers.get(a.id)}. ` : '   '}
                      <Text color={a.kind === 'do' ? 'cyan' : a.kind === 'decide' ? 'magenta' : 'yellow'}>[{a.kind}]</Text>{' '}
                      {a.text} <Text dimColor>{age(a.createdAt, now)}</Text>
                    </Text>
                    <Box flexDirection="row" gap={1}>
                      <Button key={`done:${a.id}`} label="Done" onPress={act(a, 'done')} />
                      <Button key={`dismiss:${a.id}`} label="Dismiss" onPress={act(a, 'dismissed')} />
                    </Box>
                  </Box>
                ))}
              </Box>
            ))}
          </Box>
        ))}
        <Box marginTop={1}>
          <Text dimColor>On your phone: {url}</Text>
        </Box>
      </Box>
    )
  })
}
