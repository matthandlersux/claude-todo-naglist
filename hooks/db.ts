// The asks database: an artifact's `asks` collection, reached through the
// built-in ArtifactData tool ($.tool.call), plus the pure helpers the hooks
// share. Results come back as text; everything here parses it defensively.
import type { EngineInterface } from 'claude-code'

import type { Ask, AskHere, AskKind } from '../types'

export const COLLECTION = 'asks'
export const KINDS: readonly AskKind[] = ['do', 'decide', 'answer']

export class DbError extends Error {
  isConflict: boolean
  constructor(message: string, isConflict = false) {
    super(message)
    this.isConflict = isConflict
  }
}

type DbArgs = {
  action: 'get' | 'list' | 'query' | 'set' | 'update'
  doc_id?: string
  data?: Record<string, unknown>
  if_version?: number
  query?: { where?: unknown[][]; limit?: number; cursor?: string }
}

const CONFLICT = /version|changed since|conflict/i
const REFUSED = /nothing (was )?written|writes nothing|was not written|refused|not found/i

/** One ArtifactData call on the `asks` collection; resolves the result text. */
export async function call($: EngineInterface, url: string, args: DbArgs): Promise<string> {
  const ran = await $.tool.call({ tool: 'ArtifactData', url, collection: COLLECTION, ...args })
  if (ran.deny !== undefined) throw new DbError(`ArtifactData was refused: ${ran.deny}`)
  const text =
    typeof ran.text === 'string'
      ? ran.text
      : typeof ran.result === 'string'
        ? ran.result
        : JSON.stringify(ran.result ?? '')
  const isWrite = args.action === 'set' || args.action === 'update'
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
): Promise<void> {
  const data = { status, closedAt: new Date().toISOString(), closedBy }
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

// ---- pure helpers -------------------------------------------------------

export function newId(now: number): string {
  return `a-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function baseName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path
}

const newestFirst = (a: Ask, b: Ask) => b.createdAt.localeCompare(a.createdAt)

/** This session's open asks in the numbered order the band, pane and /asks use. */
export function sessionAsks(asks: readonly Ask[], here: AskHere | null): Ask[] {
  if (!here) return []
  return asks.filter(a => a.sessionId === here.sessionId).sort(newestFirst)
}

export function folderAsks(asks: readonly Ask[], here: AskHere | null): Ask[] {
  if (!here) return []
  return asks.filter(a => a.folder === here.folder).sort(newestFirst)
}

/** The band's one line, or '' when this session has nothing open. */
export function bandText(asks: readonly Ask[], here: AskHere | null): string {
  const mine = sessionAsks(asks, here)
  if (mine.length === 0) return ''
  const counts = KINDS.map(k => [k, mine.filter(a => a.kind === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`)
  const inFolder = folderAsks(asks, here).length
  const extra = inFolder > mine.length ? `   (${inFolder} in this folder)` : ''
  return `${mine.length} open for you · ${counts.join(' · ')}${extra}   /asks`
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

/** Parses the sweep model's reply: a JSON array of { text, kind }. */
export function parseSweep(text: string): { text: string; kind: AskKind }[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const list = JSON.parse(text.slice(start, end + 1)) as unknown
    if (!Array.isArray(list)) return []
    return list
      .filter((o): o is { text: string; kind?: unknown } => !!o && typeof o.text === 'string' && o.text.trim() !== '')
      .map(o => ({ text: o.text.trim().slice(0, 300), kind: KINDS.includes(o.kind as AskKind) ? (o.kind as AskKind) : 'do' }))
      .slice(0, 5)
  } catch {
    return []
  }
}

/** A cheap first look: is the reply long enough, and does it address the user? */
export function mightHoldAsks(answer: string): boolean {
  if (answer.trim().length < 200) return false
  return /\?|\byou\b|\byour\b|decide|confirm|let me know|to do|run\b|approve|ok\b/i.test(answer)
}
