import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { bandText, parseDocs } from '../hooks/db'
import type { Ask } from '../types'

const URL = 'https://claude.ai/artifact/HNv6tEtKy3rXX2QzkVqRHs'

type DbCall = Record<string, unknown> & { action: string; if_version?: number; data?: Record<string, unknown> }

const BAND = {
  plugin: 'asks',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

/** Stands for the engine beneath the plugin; `db` answers each ArtifactData call. */
function engine(on: On, db: (e: DbCall) => { text: string; isError?: true }) {
  const calls: DbCall[] = []
  mock.clock(on, { now: Date.parse('2026-11-19T12:00:00Z') })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.repo', () => ({ value: { root: '/home/m/repo', remote: null, internal: false, name: null } }))
  on('session.cwd', () => ({ value: '/home/m/repo/sub' }))
  on('session.usage', () => ({ value: { startedAt: Date.parse('2026-11-19T11:00:00Z') } as never }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__asks__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.log', () => ({ value: undefined }) as never)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' as const }] }))
  on('tool.call', { tool: 'ArtifactData' }, (_, e) => {
    const call = e as unknown as DbCall
    calls.push(call)
    const out = db(call)
    return out.isError ? { isError: true, result: out.text, text: out.text } : { result: out.text, text: out.text }
  })
  return calls
}

const okDb = (e: DbCall) =>
  e.action === 'set' ? { text: `Set asks/${String(e.doc_id)} at version 3.` } : { text: 'No documents matched in collection "asks".' }

async function start($: Engine) {
  await $.session.start({ cwd: '/home/m/repo/sub', surface: 'terminal', isInteractive: true })
}

const composeArgs = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] }

test('band text counts this session, by kind, with the folder total', () => {
  const base = { version: 1, status: 'open', folder: '/r', folderName: 'r', sessionName: '', sessionStarted: '', closedAt: null, closedBy: null, source: 'tool' } as const
  const asks: Ask[] = [
    { ...base, id: 'a', text: 'x', kind: 'do', sessionId: 's1', createdAt: '2026-11-19T01:00:00Z' },
    { ...base, id: 'b', text: 'y', kind: 'decide', sessionId: 's1', createdAt: '2026-11-19T02:00:00Z' },
    { ...base, id: 'c', text: 'z', kind: 'answer', sessionId: 's2', createdAt: '2026-11-19T03:00:00Z' },
  ]
  expect(bandText(asks, { sessionId: 's1', folder: '/r' })).toBe('2 open for you · 1 do · 1 decide   (3 in this folder)   /asks')
  expect(bandText(asks, { sessionId: 's9', folder: '/r' })).toBe('')
})

test('parses the documents between the db markers', () => {
  const text = [
    'Found 1 document.',
    '=== BEGIN ARTIFACT DB asks ===',
    '{"id":"a-1","data":{"text":"t","status":"open"},"version":2,"updatedAt":"x"}',
    '=== END ARTIFACT DB asks ===',
  ].join('\n')
  expect(parseDocs(text)).toEqual([{ id: 'a-1', data: { text: 't', status: 'open' }, version: 2 }])
})

test('asks_add writes a set through ArtifactData and the band shows it', async ($, on) => {
  const calls = engine(on, okDb)
  await start($)

  const ran = await $.tool.call({ tool: 'mcp__asks__asks_add', text: 'Rotate the API key on sodium', kind: 'do' })
  expect(ran.text ?? String(ran.result)).toMatch(/^Filed a-/)

  const set = calls.find(c => c.action === 'set')
  expect(set?.url).toBe(URL)
  expect(set?.collection).toBe('asks')
  expect(set?.if_version).toBeUndefined()
  expect(set?.data?.text).toBe('Rotate the API key on sodium')
  expect(set?.data?.kind).toBe('do')
  expect(set?.data?.status).toBe('open')
  expect(set?.data?.folder).toBe('/home/m/repo')
  expect(set?.data?.folderName).toBe('repo')
  expect(set?.data?.sessionId).toBe('sess-1')
  expect(set?.data?.source).toBe('tool')
  expect(set?.data?.sessionStarted).toBe('2026-11-19T11:00:00.000Z')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ key: 'asks-band' }))?.text).toMatch(/^1 open for you · 1 do/)
    await ui.unmount()
  }

  // the same text again is not filed twice
  await $.tool.call({ tool: 'mcp__asks__asks_add', text: 'rotate the API key on sodium.', kind: 'do' })
  expect(calls.filter(c => c.action === 'set').length).toBe(1)
})

test('asks_resolve passes if_version, and retries once on a conflict', async ($, on) => {
  let updates = 0
  const calls = engine(on, e => {
    if (e.action === 'update') {
      updates += 1
      return updates === 1 ? { text: 'Not written: the document changed since version 3 (now 4).', isError: true } : { text: 'Updated at version 5.' }
    }
    if (e.action === 'get') {
      return {
        text: `=== BEGIN ARTIFACT DB asks ===\n{"id":"${String(e.doc_id)}","data":{"text":"Pick a name","kind":"decide","status":"open"},"version":4}\n=== END ARTIFACT DB asks ===`,
      }
    }
    return okDb(e)
  })
  await start($)

  const added = await $.tool.call({ tool: 'mcp__asks__asks_add', text: 'Pick a name', kind: 'decide' })
  const id = /a-[a-z0-9]+-[a-z0-9]+/.exec(added.text ?? String(added.result))?.[0] ?? ''

  const ran = await $.tool.call({ tool: 'mcp__asks__asks_resolve', id, status: 'done' })
  expect(ran.text ?? String(ran.result)).toBe(`Marked ${id} done.`)
  const writes = calls.filter(c => c.action === 'update')
  expect(writes.map(w => w.if_version)).toEqual([3, 4])
  expect(writes[1]?.data?.status).toBe('done')
  expect(writes[1]?.data?.closedBy).toBe('session')
  expect(typeof writes[1]?.data?.closedAt).toBe('string')
})

test('/asks off: no prompt section, tools refuse, no band; /asks on brings it back', async ($, on) => {
  const calls = engine(on, okDb)
  await start($)
  await $.tool.call({ tool: 'mcp__asks__asks_add', text: 'Answer the question', kind: 'answer' })

  const hasSection = async () => (await $.prompt.compose(composeArgs)).sections.some(s => s.id === 'asks:asks')
  expect(await hasSection()).toBe(true)

  await $.command.run({ command: 'asks', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(await hasSection()).toBe(false)
  const ran = await $.tool.call({ tool: 'mcp__asks__asks_add', text: 'Something else', kind: 'do' })
  expect(ran.text ?? String(ran.result)).toMatch(/asks capture is off in this session/)
  expect(calls.filter(c => c.action === 'set').length).toBe(1)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'asks-band' })).toBeUndefined()
  await ui.unmount()

  await $.command.run({ command: 'asks', args: 'on', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(await hasSection()).toBe(true)
})

test('the pane lists the ask with its number and Done closes it, on every surface', async ($, on) => {
  const calls = engine(on, e => (e.action === 'update' ? { text: 'Updated at version 4.' } : okDb(e)))
  await start($)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const added = await $.tool.call({ tool: 'mcp__asks__asks_add', text: `Check the backup on ${surface}`, kind: 'do' })
    const id = /a-[a-z0-9]+-[a-z0-9]+/.exec(added.text ?? String(added.result))?.[0] ?? ''
    const ui = await $.ui.mount({
      plugin: 'asks',
      surface,
      component: 'Pane',
      requestId: 'asks',
      props: { title: 'Asks', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: /1\. \[do\] Check the backup/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /HNv6tEtKy3rXX2QzkVqRHs/ })).toBeDefined()
    await ui.press({ key: `done:${id}` })
    expect(calls.filter(c => c.action === 'update').at(-1)?.data?.closedBy).toBe('pane')
    expect(await ui.find({ type: 'Text', text: /Nothing open here/ })).toBeDefined()
    await ui.unmount()
  }
})
