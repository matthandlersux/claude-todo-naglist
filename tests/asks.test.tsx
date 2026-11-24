import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { bandText, byPriority, nameFromPrompt, ordered, parseDocs, sessionLabel, titleFromTranscript, triageChanges, triageDue } from '../hooks/db'
import type { Ask } from '../types'

const URL = 'https://claude.ai/artifact/HNv6tEtKy3rXX2QzkVqRHs'

type DbCall = Record<string, unknown> & { action: string; if_version?: number; data?: Record<string, unknown> }

const BAND = {
  plugin: 'qs',
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

let clock: ReturnType<typeof mock.clock>
const submitted: string[] = []

/** Stands for the engine beneath the plugin; `db` answers each ArtifactData call. */
function engine(on: On, db: (e: DbCall) => { text: string; isError?: true }) {
  const calls: DbCall[] = []
  clock = mock.clock(on, { now: Date.parse('2026-11-19T12:00:00Z') })
  submitted.length = 0
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text } as never
  })
  on('ui.toast', () => ({ value: undefined }) as never)
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }) as never)
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.repo', () => ({ value: { root: '/home/m/repo', remote: null, internal: false, name: null } }))
  on('session.cwd', () => ({ value: '/home/m/repo/sub' }))
  on('session.usage', () => ({ value: { startedAt: Date.parse('2026-11-19T11:00:00Z') } as never }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__qs__${e.name}` } }))
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

const base = {
  version: 1,
  status: 'open',
  folder: '/r',
  folderName: 'r',
  sessionName: '',
  sessionStarted: '',
  closedAt: null,
  closedBy: null,
  source: 'tool',
  urgency: 'soon',
  ignorable: false,
  blocks: '',
  rank: null,
  triagedAt: null,
  options: [] as string[],
  answer: null,
  deliveredAt: null,
  group: '',
  step: null,
} as const

const composeArgs = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] }

test('band text counts this session, by kind, with the folder total', () => {
  const asks: Ask[] = [
    { ...base, id: 'a', text: 'x', kind: 'do', sessionId: 's1', createdAt: '2026-11-19T01:00:00Z' },
    { ...base, id: 'b', text: 'y', kind: 'decide', sessionId: 's1', createdAt: '2026-11-19T02:00:00Z' },
    { ...base, id: 'c', text: 'z', kind: 'answer', sessionId: 's2', createdAt: '2026-11-19T03:00:00Z' },
  ]
  expect(bandText(asks, { sessionId: 's1', folder: '/r' })).toBe("2 q's for you · 1 do · 1 decide   (3 in this folder)   /qs")
  expect(bandText(asks, { sessionId: 's9', folder: '/r' })).toBe('')
  expect(bandText([{ ...asks[0]!, urgency: 'now' }, asks[1]!], { sessionId: 's1', folder: '/r' })).toMatch(/^2 q's for you · 1 now · 1 do/)
})

test('priority: urgency, then not ignorable, then untriaged, then rank, then newest', () => {
  const a = (id: string, o: Partial<Ask>): Ask => ({ ...base, id, text: id, kind: 'do', sessionId: 's', createdAt: '2026-11-19T01:00:00Z', ...o })
  const list = [
    a('later', { urgency: 'later', rank: 1, triagedAt: 'x' }),
    a('soon-ignorable', { ignorable: true, rank: 1, triagedAt: 'x' }),
    a('soon-rank2', { rank: 2, triagedAt: 'x' }),
    a('soon-new', {}),
    a('soon-rank1', { rank: 1, triagedAt: 'x' }),
    a('now', { urgency: 'now', rank: 9, triagedAt: 'x' }),
  ]
  expect([...list].sort(byPriority).map(x => x.id)).toEqual(['now', 'soon-new', 'soon-rank1', 'soon-rank2', 'soon-ignorable', 'later'])
})

test('triage: ranks by position, writes only changes, skips unknown ids; due rules', () => {
  const a = (id: string, o: Partial<Ask>): Ask => ({ ...base, id, text: id, kind: 'do', sessionId: 's', createdAt: '2026-11-19T01:00:00Z', ...o })
  const open = [a('x', { rank: 1, triagedAt: 't' }), a('y', {})]
  const reply = 'Here: [{"id":"y","urgency":"now","ignorable":false,"blocks":"deploy"},{"id":"zz"},{"id":"x","urgency":"soon","ignorable":false,"blocks":""}]'
  const changes = triageChanges(reply, open, 'NOW')
  expect(changes.map(c => [c.ask.id, c.data.rank, c.data.urgency])).toEqual([
    ['y', 1, 'now'],
    ['x', 2, 'soon'],
  ])
  expect(changes[0]?.data.blocks).toBe('deploy')

  const now = Date.parse('2026-11-19T12:00:00Z')
  const ago = (min: number) => new Date(now - min * 60_000).toISOString()
  expect(triageDue(open, null, now)).toBe(true)
  expect(triageDue([], null, now)).toBe(false)
  expect(triageDue(open, { lastRun: ago(30), runningUntil: '' }, now)).toBe(true) // y is new
  expect(triageDue([open[0]!], { lastRun: ago(30), runningUntil: '' }, now)).toBe(false)
  expect(triageDue([open[0]!], { lastRun: ago(7 * 60), runningUntil: '' }, now)).toBe(true)
  expect(triageDue(open, { lastRun: ago(7 * 60), runningUntil: ago(-5) }, now)).toBe(false)
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

test('asks_add writes a set through ArtifactData and the band shows it', { options: { artifactUrl: URL } }, async ($, on) => {
  const calls = engine(on, okDb)
  await start($)

  const ran = await $.tool.call({
    tool: 'mcp__qs__qs_add',
    text: 'Rotate the API key on sodium',
    kind: 'do',
    urgency: 'now',
    ignorable: false,
    blocks: 'the deploy',
  })
  expect(ran.text ?? String(ran.result)).toMatch(/^Filed a-.* \(do, now\)/)

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
  expect(set?.data?.urgency).toBe('now')
  expect(set?.data?.ignorable).toBe(false)
  expect(set?.data?.blocks).toBe('the deploy')
  expect(set?.data?.rank).toBeNull()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ key: 'qs-band' }))?.text).toMatch(/^📌 1 q's for you · 1 now · 1 do/)
    await ui.unmount()
  }

  // the same text again is not filed twice
  await $.tool.call({ tool: 'mcp__qs__qs_add', text: 'rotate the API key on sodium.', kind: 'do' })
  expect(calls.filter(c => c.action === 'set').length).toBe(1)
})

test('asks_resolve passes if_version, and retries once on a conflict', { options: { artifactUrl: URL } }, async ($, on) => {
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

  const added = await $.tool.call({ tool: 'mcp__qs__qs_add', text: 'Pick a name', kind: 'decide' })
  const id = /a-[a-z0-9]+-[a-z0-9]+/.exec(added.text ?? String(added.result))?.[0] ?? ''

  const ran = await $.tool.call({ tool: 'mcp__qs__qs_resolve', id, status: 'done' })
  expect(ran.text ?? String(ran.result)).toBe(`Marked ${id} done.`)
  const writes = calls.filter(c => c.action === 'update')
  expect(writes.map(w => w.if_version)).toEqual([3, 4])
  expect(writes[1]?.data?.status).toBe('done')
  expect(writes[1]?.data?.closedBy).toBe('session')
  expect(typeof writes[1]?.data?.closedAt).toBe('string')
})

test('/asks off: no prompt section, tools refuse, no band; /asks on brings it back', { options: { artifactUrl: URL } }, async ($, on) => {
  const calls = engine(on, okDb)
  await start($)
  await $.tool.call({ tool: 'mcp__qs__qs_add', text: 'Answer the question', kind: 'answer' })

  const hasSection = async () => (await $.prompt.compose(composeArgs)).sections.some(s => s.id === 'qs:qs')
  expect(await hasSection()).toBe(true)

  await $.command.run({ command: 'qs', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(await hasSection()).toBe(false)
  const ran = await $.tool.call({ tool: 'mcp__qs__qs_add', text: 'Something else', kind: 'do' })
  expect(ran.text ?? String(ran.result)).toMatch(/Q's capture is off in this session/)
  expect(calls.filter(c => c.action === 'set').length).toBe(1)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'qs-band' })).toBeUndefined()
  await ui.unmount()

  await $.command.run({ command: 'qs', args: 'on', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(await hasSection()).toBe(true)
})

test('the pane lists the ask with its number and Done closes it, on every surface', { options: { artifactUrl: URL } }, async ($, on) => {
  const calls = engine(on, e => (e.action === 'update' ? { text: 'Updated at version 4.' } : okDb(e)))
  await start($)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const added = await $.tool.call({ tool: 'mcp__qs__qs_add', text: `Check the backup on ${surface}`, kind: 'do' })
    const id = /a-[a-z0-9]+-[a-z0-9]+/.exec(added.text ?? String(added.result))?.[0] ?? ''
    const ui = await $.ui.mount({
      plugin: 'qs',
      surface,
      component: 'Pane',
      requestId: 'qs',
      props: { title: 'Asks', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: /1\. soon \[do\] Check the backup/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /HNv6tEtKy3rXX2QzkVqRHs/ })).toBeDefined()
    await ui.press({ key: `done:${id}` })
    expect(calls.filter(c => c.action === 'update').at(-1)?.data?.closedBy).toBe('pane')
    expect(await ui.find({ type: 'Text', text: /Nothing open here/ })).toBeDefined()
    await ui.unmount()
  }
})

test('/asks triage claims the meta doc, batches the new order with version pins, then releases', { options: { artifactUrl: URL } }, async ($, on) => {
  const calls = engine(on, e => {
    if (e.action === 'query') {
      return {
        text: [
          '=== BEGIN ARTIFACT DB asks ===',
          '{"id":"a1","data":{"text":"Old thing","kind":"do","status":"open","urgency":"later","rank":1,"triagedAt":"t","createdAt":"2026-11-18T00:00:00Z"},"version":7}',
          '{"id":"a2","data":{"text":"Approve the deploy","kind":"decide","status":"open","createdAt":"2026-11-19T11:50:00Z"},"version":2}',
          '=== END ARTIFACT DB asks ===',
        ].join('\n'),
      }
    }
    if (e.action === 'batch') return { text: 'Batch applied: 2 writes.' }
    return okDb(e)
  })
  on('model.complete', () => ({ value: {
    isAnswered: true,
    text: '[{"id":"a2","urgency":"now","ignorable":false,"blocks":"the release"},{"id":"a1","urgency":"later","ignorable":true,"blocks":""}]',
  } }) as never)
  await start($)

  const out = await $.command.run({ command: 'qs', args: 'triage', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(out.text).toBe("Triaged 2 q's; 2 changed.")
  const metaWrites = calls.filter(c => c.collection === 'asksMeta' && c.action !== 'get')
  expect(metaWrites.length).toBe(2)
  expect(String(metaWrites[0]?.data?.runningUntil)).not.toBe('')
  expect(metaWrites[1]?.data?.runningUntil).toBe('')
  const batch = calls.find(c => c.action === 'batch') as unknown as { collection?: string; writes: { doc_id: string; if_version: number; collection: string; data: Record<string, unknown> }[] }
  expect(batch.collection).toBeUndefined()
  expect(batch.writes.map(w => [w.doc_id, w.if_version, w.data.rank, w.collection])).toEqual([
    ['a2', 2, 1, 'asks'],
    ['a1', 7, 2, 'asks'],
  ])
  expect(batch.writes[1]?.data.ignorable).toBe(true)
})

test('an answer button closes the q with the answer and sends it into this session', { options: { artifactUrl: URL } }, async ($, on) => {
  const calls = engine(on, e => (e.action === 'update' ? { text: 'Updated at version 4.' } : okDb(e)))
  await start($)
  const added = await $.tool.call({
    tool: 'mcp__qs__qs_add',
    text: 'Decide whether to push claude-todo-naglist',
    kind: 'decide',
    urgency: 'soon',
    ignorable: false,
    options: ['Push', 'Not yet', 'push', '', 'Extra', 'Four'],
  })
  const id = /a-[a-z0-9]+-[a-z0-9]+/.exec(added.text ?? String(added.result))?.[0] ?? ''
  expect(calls.find(c => c.action === 'set')?.data?.options).toEqual(['Push', 'Not yet', 'Extra'])

  const ui = await $.ui.mount({
    plugin: 'qs',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'qs',
    props: { title: "Q's", isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  expect(await ui.find({ key: `done:${id}` })).toBeUndefined()
  await ui.press({ key: `answer:${id}:0` })
  const write = calls.filter(c => c.action === 'update').at(-1)
  expect(write?.data?.status).toBe('done')
  expect(write?.data?.answer).toBe('Push')
  expect(typeof write?.data?.deliveredAt).toBe('string')
  expect(submitted).toEqual(['Answer to "Decide whether to push claude-todo-naglist": Push'])
  await ui.unmount()
})

test('answers picked on the page reach the filing session once, pinned to the version read', { options: { artifactUrl: URL } }, async ($, on) => {
  let delivered = false
  const calls = engine(on, e => {
    if (e.action === 'query' && JSON.stringify(e.query).includes('sessionId')) {
      return delivered
        ? { text: 'No documents matched.' }
        : {
            text: [
              '=== BEGIN ARTIFACT DB asks ===',
              '{"id":"a-x","data":{"text":"Approve the deploy","kind":"decide","status":"done","sessionId":"sess-1","answer":"Deploy","options":["Deploy","Wait"]},"version":6}',
              '{"id":"a-y","data":{"text":"Old","kind":"do","status":"done","sessionId":"sess-1","answer":"Yes","deliveredAt":"t"},"version":2}',
              '=== END ARTIFACT DB asks ===',
            ].join('\n'),
          }
    }
    if (e.action === 'query') {
      return {
        text: '=== BEGIN ARTIFACT DB asks ===\n{"id":"a-x","data":{"text":"Approve the deploy","kind":"decide","status":"open","sessionId":"sess-1","createdAt":"2026-11-19T11:00:00Z"},"version":5}\n=== END ARTIFACT DB asks ===',
      }
    }
    if (e.action === 'update') {
      delivered = true
      return { text: 'Updated at version 7.' }
    }
    return okDb(e)
  })
  await start($)
  // the cache still holds it as open (read before the page answered it)
  await $.tool.call({ tool: 'mcp__qs__qs_list' })
  const before = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await before.find({ key: 'qs-band' }))?.text).toMatch(/^📌 1 q's for you/)
  await before.unmount()
  await clock.advance(5_000)
  // delivered: gone from the band without waiting for a refresh
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'qs-band' })).toBeUndefined()
  await ui.unmount()
  const marks = calls.filter(c => c.action === 'update')
  expect(marks.map(m => [m.doc_id, m.if_version, typeof m.data?.deliveredAt])).toEqual([['a-x', 6, 'string']])
  expect(submitted).toEqual(['Answer to "Approve the deploy": Deploy'])
  await clock.advance(60_000)
  expect(submitted.length).toBe(1)
})

test('groups stay together in step order, placed where their most pressing q would be', () => {
  const a = (id: string, o: Partial<Ask>): Ask => ({ ...base, id, text: id, kind: 'do', sessionId: 's', createdAt: '2026-11-19T01:00:00Z', ...o })
  const list = [
    a('lone-later', { urgency: 'later' }),
    a('fix-3', { group: 'fix', step: 3, urgency: 'now' }),
    a('fix-1', { group: 'fix', step: 1, urgency: 'later' }),
    a('lone-soon', {}),
    a('fix-2', { group: 'fix', step: 2 }),
    a('other-fix-1', { group: 'fix', step: 1, folder: '/elsewhere' }),
  ]
  expect(ordered(list).map(x => x.id)).toEqual(['fix-1', 'fix-2', 'fix-3', 'lone-soon', 'other-fix-1', 'lone-later'])
})

test('sessions are named by title, else first prompt, never by id', () => {
  expect(sessionLabel({ sessionName: 'router work', sessionStarted: '', createdAt: '' })).toBe('router work')
  expect(sessionLabel({ sessionName: '', sessionStarted: '2026-11-19T14:05:00', createdAt: '' })).toBe('session from 11-19 14:05')
  expect(nameFromPrompt('<system-reminder>x</system-reminder>  fix the   router\nplease')).toBe('fix the router please')
  expect(nameFromPrompt('a'.repeat(80))).toHaveLength(50)
  // /qs names: the latest name the person gave wins over generated ones
  const lines = ['"aiTitle":"Router slowdown"', '"customTitle":"router \\"swap\\""', '"aiTitle":"Later guess"'].join('\n')
  expect(titleFromTranscript(lines)).toBe('router "swap"')
  expect(titleFromTranscript('"aiTitle":"Only generated"\n')).toBe('Only generated')
  expect(titleFromTranscript('')).toBe('')
})

test('without a list page: setup hint on the band, tools refuse, /qs setup <link> stores it', async ($, on) => {
  const calls = engine(on, okDb)
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /run \/qs setup/ })).toBeDefined()
  await ui.unmount()
  const r = await $.tool.call({ tool: 'mcp__qs__qs_add', text: 'Check the backup', kind: 'do', urgency: 'soon', ignorable: false } as never)
  expect(String(r.result)).toMatch(/isn't set up/)
  expect(calls).toHaveLength(0)
  const out = await $.command.run({ command: 'qs', args: 'setup https://claude.ai/artifact/AbC123xyz', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(String((out as { text?: string }).text)).toMatch(/Using https:\/\/claude\.ai\/artifact\/AbC123xyz/)
  await $.tool.call({ tool: 'mcp__qs__qs_add', text: 'Check the backup', kind: 'do', urgency: 'soon', ignorable: false } as never)
  expect(calls.find(c => c.action === 'set')?.url).toBe('https://claude.ai/artifact/AbC123xyz')
})

test('qs_add takes a group and step; qs_order regroups open q\'s in the given order', { options: { artifactUrl: URL } }, async ($, on) => {
  const docs = [
    '{"id":"a-1","data":{"text":"Second thing","kind":"do","status":"open","sessionId":"sess-1","folder":"/home/m/repo"},"version":2}',
    '{"id":"a-2","data":{"text":"First thing","kind":"do","status":"open","sessionId":"sess-1","folder":"/home/m/repo"},"version":5}',
  ]
  const calls = engine(on, e =>
    e.action === 'set'
      ? { text: `Set asks/${String(e.doc_id)} at version 3.` }
      : e.action === 'batch'
        ? { text: 'Applied 2 writes.' }
        : { text: `BEGIN\n${docs.join('\n')}\nEND` },
  )
  await start($)
  await $.tool.call({ tool: 'mcp__qs__qs_add', text: 'Swap the router', kind: 'do', urgency: 'soon', ignorable: false, group: 'Router Swap!', step: 2 } as never)
  const set = calls.find(c => c.action === 'set')
  expect([set?.data?.group, set?.data?.step]).toEqual(['router-swap', 2])
  const r = await $.tool.call({ tool: 'mcp__qs__qs_order', ids: ['a-2', 'a-1'], group: 'setup' } as never)
  expect(String(r.result)).toMatch(/Grouped 2/)
  const batch = calls.find(c => c.action === 'batch') as unknown as { writes: { doc_id: string; data: Record<string, unknown>; if_version: number }[] }
  expect(batch.writes.map(w => [w.doc_id, w.data.group, w.data.step, w.if_version])).toEqual([
    ['a-2', 'setup', 1, 5],
    ['a-1', 'setup', 2, 2],
  ])
})
