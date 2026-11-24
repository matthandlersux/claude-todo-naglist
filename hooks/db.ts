// The asks database: an artifact's `asks` collection, reached through the
// built-in ArtifactData tool ($.tool.call), plus the pure helpers the hooks
// share. Results come back as text; everything here parses it defensively.
import type { EngineInterface } from 'claude-code'

import type { Ask, AskHere, AskKind, AskUrgency } from '../types'

export const COLLECTION = 'asks'
export const KINDS: readonly AskKind[] = ['do', 'decide', 'answer']
export const URGENCIES: readonly AskUrgency[] = ['now', 'soon', 'later']
/** The triage pass's bookkeeping: one doc, so sessions don't all run it at once. */
export const META_COLLECTION = 'asksMeta'
export const TRIAGE_DOC = 'triage'

export class DbError extends Error {
  isConflict: boolean
  constructor(message: string, isConflict = false) {
    super(message)
    this.isConflict = isConflict
  }
}

type BatchWrite = { op: 'update'; collection: string; doc_id: string; data: Record<string, unknown>; if_version: number }

type DbArgs = {
  action: 'get' | 'list' | 'query' | 'set' | 'update' | 'batch'
  collection?: string
  writes?: BatchWrite[]
  doc_id?: string
  data?: Record<string, unknown>
  if_version?: number
  query?: { where?: unknown[][]; limit?: number; cursor?: string }
}

const CONFLICT = /version|changed since|conflict/i
const REFUSED = /nothing (was )?written|writes nothing|was not written|refused|not found/i

/** One ArtifactData call on the `asks` collection; resolves the result text. */
export async function call($: EngineInterface, url: string, args: DbArgs): Promise<string> {
  const { collection = COLLECTION, ...rest } = args
  const ran = await $.tool.call({
    tool: 'ArtifactData',
    url,
    ...(args.action === 'batch' ? {} : { collection }),
    ...rest,
  })
  if (ran.deny !== undefined) throw new DbError(`ArtifactData was refused: ${ran.deny}`)
  const text =
    typeof ran.text === 'string'
      ? ran.text
      : typeof ran.result === 'string'
        ? ran.result
        : JSON.stringify(ran.result ?? '')
  const isWrite = args.action === 'set' || args.action === 'update' || args.action === 'batch'
  if (ran.isError === true || (isWrite && REFUSED.test(text))) {
    throw new DbError(text.slice(0, 300), isWrite && CONFLICT.test(text))
  }
  return text
}

type RawDoc = { id: string; data: Record<string, unknown>; version: number }

/** The documents in a read's text: JSON lines between the BEGIN/END markers. */
export function parseDocs(text: string): RawDoc[] {
  const lines = text.split('\n')
  const begin = lines.findIndex(l => /^=== BEGIN ARTIFACT DB/.test(l.trim()))
  const end = lines.findIndex((l, i) => i > begin && /^=== END ARTIFACT DB/.test(l.trim()))
  const body = begin >= 0 ? lines.slice(begin + 1, end > begin ? end : undefined) : lines
  const docs: RawDoc[] = []
  for (const line of body) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const o = JSON.parse(t) as Record<string, unknown>
      if (typeof o.id === 'string' && o.data !== null && typeof o.data === 'object') {
        docs.push({ id: o.id, data: o.data as Record<string, unknown>, version: Number(o.version) || 0 })
      }
    } catch {
      // not a document line
    }
  }
  return docs
}

/** The version a write's result names, or 0. */
export function parseVersion(text: string): number {
  const m = /"?version"?\s*[:=]?\s*(\d+)/i.exec(text)
  return m ? Number(m[1]) : 0
}

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)

export function toAsk(doc: RawDoc): Ask | null {
  const d = doc.data
  const text = str(d.text)
  if (!text) return null
  const kind = KINDS.includes(d.kind as AskKind) ? (d.kind as AskKind) : 'do'
  const status = d.status === 'done' || d.status === 'dismissed' ? d.status : 'open'
  return {
    id: doc.id,
    version: doc.version,
    text,
    kind,
    status,
    folder: str(d.folder),
    folderName: str(d.folderName),
    sessionId: str(d.sessionId),
    sessionName: str(d.sessionName),
    sessionStarted: str(d.sessionStarted),
    createdAt: str(d.createdAt),
    closedAt: typeof d.closedAt === 'string' ? d.closedAt : null,
    closedBy: typeof d.closedBy === 'string' ? d.closedBy : null,
    source: d.source === 'sweep' ? 'sweep' : 'tool',
    urgency: URGENCIES.includes(d.urgency as AskUrgency) ? (d.urgency as AskUrgency) : 'soon',
    ignorable: d.ignorable === true,
    blocks: str(d.blocks),
    rank: typeof d.rank === 'number' ? d.rank : null,
    triagedAt: typeof d.triagedAt === 'string' ? d.triagedAt : null,
    options: cleanOptions(d.options),
    answer: typeof d.answer === 'string' && d.answer !== '' ? d.answer : null,
    deliveredAt: typeof d.deliveredAt === 'string' ? d.deliveredAt : null,
    group: cleanGroup(d.group),
    step: cleanStep(d.step),
  }
}

/** A group tag as stored: lowercase kebab-case, at most 40 characters, '' for none. */
export function cleanGroup(v: unknown): string {
  if (typeof v !== 'string') return ''
  return v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

/** A step number as stored: a positive whole number, else null. */
export function cleanStep(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null
}

/** Up to 3 short, distinct button labels. */
export function cleanOptions(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const o of v) {
    if (typeof o !== 'string') continue
    const t = o.trim().slice(0, 40)
    if (t && !out.some(x => x.toLowerCase() === t.toLowerCase())) out.push(t)
  }
  return out.slice(0, 3)
}

/** This session's answered asks whose answer hasn't reached the conversation yet. */
export async function readUndelivered($: EngineInterface, url: string, sessionId: string): Promise<Ask[]> {
  const text = await call($, url, { action: 'query', query: { where: [['sessionId', '==', sessionId]], limit: 1000 } })
  return parseDocs(text)
    .map(toAsk)
    .filter((a): a is Ask => a !== null && a.answer !== null && a.deliveredAt === null)
}

/** Marks an answer delivered, pinned to the version it was read at: false when another reader got there first. */
export async function markDelivered($: EngineInterface, url: string, ask: Ask, nowIso: string): Promise<boolean> {
  try {
    await call($, url, { action: 'update', doc_id: ask.id, data: { deliveredAt: nowIso }, if_version: ask.version })
    return true
  } catch (err) {
    if (err instanceof DbError && err.isConflict) return false
    throw err
  }
}

/** Every open ask in the db (a query; falls back to a filtered list). */
export async function readOpen($: EngineInterface, url: string): Promise<Ask[]> {
  let text: string
  try {
    text = await call($, url, { action: 'query', query: { where: [['status', '==', 'open']], limit: 1000 } })
  } catch {
    text = await call($, url, { action: 'list', query: { limit: 1000 } })
  }
  return parseDocs(text)
    .map(toAsk)
    .filter((a): a is Ask => a !== null && a.status === 'open')
}

/** Every ask in the db, open or closed. */
export async function readAll($: EngineInterface, url: string): Promise<Ask[]> {
  const text = await call($, url, { action: 'list', query: { limit: 1000 } })
  return parseDocs(text)
    .map(toAsk)
    .filter((a): a is Ask => a !== null)
}

export async function readOne($: EngineInterface, url: string, id: string): Promise<Ask | null> {
  const docs = parseDocs(await call($, url, { action: 'get', doc_id: id }))
  const doc = docs.find(d => d.id === id) ?? docs[0]
  return doc ? toAsk(doc) : null
}

/** Creates the ask; resolves the version the db gave it (0 when unsaid). */
export async function create($: EngineInterface, url: string, ask: Ask): Promise<number> {
  const { id, version: _v, ...data } = ask
  return parseVersion(await call($, url, { action: 'set', doc_id: id, data }))
}

/** Closes an ask, pinned to its version; on a conflict re-reads and retries once. */
export async function close(
  $: EngineInterface,
  url: string,
  ask: Ask,
  status: 'done' | 'dismissed',
  closedBy: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const data = { status, closedAt: new Date().toISOString(), closedBy, ...extra }
  let version = ask.version
  if (!version) version = (await readOne($, url, ask.id))?.version ?? 0
  try {
    await call($, url, { action: 'update', doc_id: ask.id, data, if_version: version })
  } catch (err) {
    if (!(err instanceof DbError) || !err.isConflict) throw err
    const fresh = await readOne($, url, ask.id)
    if (!fresh) throw new DbError(`ask ${ask.id} is gone`)
    if (fresh.status !== 'open') return
    await call($, url, { action: 'update', doc_id: ask.id, data, if_version: fresh.version })
  }
}

export type TriageMeta = { version: number; lastRun: string; runningUntil: string }

export async function readTriageMeta($: EngineInterface, url: string): Promise<TriageMeta | null> {
  const text = await call($, url, { action: 'get', collection: META_COLLECTION, doc_id: TRIAGE_DOC }).catch(() => '')
  const doc = parseDocs(text).find(d => d.id === TRIAGE_DOC)
  if (!doc) return null
  return { version: doc.version, lastRun: str(doc.data.lastRun), runningUntil: str(doc.data.runningUntil) }
}

/** Writes the triage doc, pinned to the version last read (creates it when there is none). */
export async function writeChangesMeta(
  $: EngineInterface,
  url: string,
  meta: TriageMeta | null,
  data: { lastRun: string; runningUntil: string },
): Promise<number> {
  const text = meta
    ? await call($, url, { action: 'update', collection: META_COLLECTION, doc_id: TRIAGE_DOC, data, if_version: meta.version })
    : await call($, url, { action: 'set', collection: META_COLLECTION, doc_id: TRIAGE_DOC, data })
  return parseVersion(text)
}

/** Applies a triage's changes in batches of 50, each pinned to the version it was judged at. */
export async function writeChanges(
  $: EngineInterface,
  url: string,
  changes: { ask: Ask; data: Record<string, unknown> }[],
): Promise<void> {
  for (let i = 0; i < changes.length; i += 50) {
    const writes = changes.slice(i, i + 50).map(({ ask, data }) => ({
      op: 'update' as const,
      collection: COLLECTION,
      doc_id: ask.id,
      data,
      if_version: ask.version,
    }))
    await call($, url, { action: 'batch', writes })
  }
}

// ---- pure helpers -------------------------------------------------------

export function newId(now: number): string {
  return `a-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function baseName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path
}

/**
 * Priority order: urgency first, then what is tied to something real before what is
 * ignorable, then the last triage's rank (asks not triaged yet go first, so new ones
 * bubble up), then newest first.
 */
export function byPriority(a: Ask, b: Ask): number {
  return (
    URGENCIES.indexOf(a.urgency) - URGENCIES.indexOf(b.urgency) ||
    Number(a.ignorable) - Number(b.ignorable) ||
    (a.rank ?? 0) - (b.rank ?? 0) ||
    b.createdAt.localeCompare(a.createdAt)
  )
}

const groupKey = (a: Ask) => (a.group ? `g\u0000${a.folder}\u0000${a.group}` : `i\u0000${a.id}`)

/**
 * Priority order, with each group kept together: a group sits where its most pressing q
 * would, and its q's follow in step order (unnumbered ones last, by priority).
 */
export function ordered(asks: readonly Ask[]): Ask[] {
  const sorted = [...asks].sort(byPriority)
  const place = new Map<string, number>()
  sorted.forEach((a, i) => {
    if (!place.has(groupKey(a))) place.set(groupKey(a), i)
  })
  const pos = new Map(sorted.map((a, i) => [a.id, i]))
  const stepOf = (a: Ask) => a.step ?? Number.MAX_SAFE_INTEGER
  return sorted.sort(
    (x, y) =>
      place.get(groupKey(x))! - place.get(groupKey(y))! || stepOf(x) - stepOf(y) || pos.get(x.id)! - pos.get(y.id)!,
  )
}

/** Every open ask in order (see ordered). */
export const allAsks = (asks: readonly Ask[]): Ask[] => ordered(asks)

/** This session's open asks in the numbered order the band, pane and /qs use. */
export function sessionAsks(asks: readonly Ask[], here: AskHere | null): Ask[] {
  if (!here) return []
  return ordered(asks.filter(a => a.sessionId === here.sessionId))
}

export function folderAsks(asks: readonly Ask[], here: AskHere | null): Ask[] {
  if (!here) return []
  return ordered(asks.filter(a => a.folder === here.folder))
}

/** The band's one line, or '' when this session has nothing open. */
export function bandText(asks: readonly Ask[], here: AskHere | null): string {
  const mine = sessionAsks(asks, here)
  if (mine.length === 0) return ''
  const urgent = mine.filter(a => a.urgency === 'now').length
  const counts = KINDS.map(k => [k, mine.filter(a => a.kind === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`)
  if (urgent > 0) counts.unshift(`${urgent} now`)
  const inFolder = folderAsks(asks, here).length
  const extra = inFolder > mine.length ? `   (${inFolder} in this folder)` : ''
  return `${mine.length} q's for you · ${counts.join(' · ')}${extra}   /qs`
}

/** How a session is named to the person: its title, else when it started (never its id). */
export function sessionLabel(a: Pick<Ask, 'sessionName' | 'sessionStarted' | 'createdAt'>): string {
  if (a.sessionName) return a.sessionName
  const t = new Date(a.sessionStarted || a.createdAt)
  if (Number.isNaN(t.getTime())) return 'a session'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `session from ${t.getMonth() + 1}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`
}

/** A short session name from its first prompt: one line, tags dropped, at most 50 characters. */
export function nameFromPrompt(text: string): string {
  const line = text
    .replace(/<([a-z-]+)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return line.length > 50 ? `${line.slice(0, 49).trimEnd()}…` : line
}

/**
 * A session's name from its transcript's title lines (grep output of
 * `"customTitle":"..."` / `"aiTitle":"..."`): the last name the person gave it,
 * else the last one generated; '' when there are none.
 */
export function titleFromTranscript(lines: string): string {
  let custom = ''
  let ai = ''
  for (const line of lines.split('\n')) {
    try {
      const o = JSON.parse(`{${line.trim()}}`) as { customTitle?: unknown; aiTitle?: unknown }
      if (typeof o.customTitle === 'string' && o.customTitle.trim()) custom = o.customTitle.trim()
      if (typeof o.aiTitle === 'string' && o.aiTitle.trim()) ai = o.aiTitle.trim()
    } catch {
      continue
    }
  }
  return (custom || ai).slice(0, 80)
}

export function age(iso: string, now: number): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

/** The judgement every filed ask carries; anything missing or unknown falls back to soon / not ignorable. */
export type Judged = { urgency: AskUrgency; ignorable: boolean; blocks: string }

export function judged(o: { urgency?: unknown; ignorable?: unknown; blocks?: unknown }): Judged {
  const ignorable = o.ignorable === true
  return {
    urgency: URGENCIES.includes(o.urgency as AskUrgency) ? (o.urgency as AskUrgency) : 'soon',
    ignorable,
    blocks: ignorable || typeof o.blocks !== 'string' ? '' : o.blocks.trim().slice(0, 200),
  }
}

function jsonArray(text: string): unknown[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const list = JSON.parse(text.slice(start, end + 1)) as unknown
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/** Parses the sweep model's reply: a JSON array of { text, kind, urgency, ignorable, blocks }. */
export function parseSweep(text: string): ({ text: string; kind: AskKind; options: string[] } & Judged)[] {
  return jsonArray(text)
    .filter((o): o is { text: string; kind?: unknown; urgency?: unknown; ignorable?: unknown; blocks?: unknown } => !!o && typeof (o as { text?: unknown }).text === 'string' && (o as { text: string }).text.trim() !== '')
    .map(o => ({
      text: o.text.trim().slice(0, 300),
      kind: KINDS.includes(o.kind as AskKind) ? (o.kind as AskKind) : 'do',
      options: cleanOptions((o as { options?: unknown }).options),
      ...judged(o),
    }))
    .slice(0, 5)
}

/**
 * Parses the triage model's reply, a JSON array of { id, urgency, ignorable, blocks } in
 * priority order, into the writes it implies: rank by position, only the asks that change.
 * Asks the reply leaves out keep what they had.
 */
export function triageChanges(text: string, open: readonly Ask[], nowIso: string): { ask: Ask; data: Record<string, unknown> }[] {
  const byId = new Map(open.map(a => [a.id, a]))
  const seen = new Set<string>()
  const changes: { ask: Ask; data: Record<string, unknown> }[] = []
  for (const o of jsonArray(text)) {
    const id = (o as { id?: unknown })?.id
    if (typeof id !== 'string' || seen.has(id)) continue
    const ask = byId.get(id)
    if (!ask) continue
    seen.add(id)
    const j = judged(o as Record<string, unknown>)
    const rank = seen.size
    if (ask.rank === rank && ask.urgency === j.urgency && ask.ignorable === j.ignorable && ask.blocks === j.blocks && ask.triagedAt) continue
    changes.push({ ask, data: { ...j, rank, triagedAt: nowIso } })
  }
  return changes
}

/** When a triage pass is due: every 6 hours, or 20 minutes after the last one when new asks wait. */
export function triageDue(open: readonly Ask[], meta: { lastRun: string; runningUntil: string } | null, now: number): boolean {
  if (open.length === 0) return false
  if (meta && Date.parse(meta.runningUntil) > now) return false
  const last = meta ? Date.parse(meta.lastRun) : NaN
  if (Number.isNaN(last)) return true
  const waiting = open.some(a => a.triagedAt === null)
  return now - last > 6 * 3600_000 || (waiting && now - last > 20 * 60_000)
}

/** A cheap first look: is the reply long enough, and does it address the user? */
export function mightHoldAsks(answer: string): boolean {
  if (answer.trim().length < 200) return false
  return /\?|\byou\b|\byour\b|decide|confirm|let me know|to do|run\b|approve|ok\b/i.test(answer)
}
