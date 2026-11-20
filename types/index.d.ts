// qs (claude-todo-naglist repo): the state contract. The db (an artifact's `asks` collection)
// is the truth; this is the session's cache of it, so drawing is synchronous.

export type AskKind = 'do' | 'decide' | 'answer'
export type AskStatus = 'open' | 'done' | 'dismissed'
/** Time pressure: now (today, or something is waiting on it), soon (this week), later (no clock). */
export type AskUrgency = 'now' | 'soon' | 'later'

/** One ask as the db holds it, plus its db `id` and last-read `version`. */
export type Ask = {
  id: string
  version: number
  text: string
  kind: AskKind
  status: AskStatus
  folder: string
  folderName: string
  sessionId: string
  sessionName: string
  sessionStarted: string
  createdAt: string
  closedAt: string | null
  closedBy: string | null
  source: 'tool' | 'sweep'
  urgency: AskUrgency
  /** True when nothing real is tied to it, blocked on it or half done: it can sit forever. */
  ignorable: boolean
  /** What it blocks, is tied to, or what is half done; '' when ignorable. */
  blocks: string
  /** Position from the last triage pass (1 = first), null until triaged. */
  rank: number | null
  triagedAt: string | null
}

/** Where this session is: what the band and the Session/Folder tabs filter on. */
export type AskHere = { sessionId: string; folder: string }

export type AskTab = 'session' | 'folder' | 'all'

declare module 'claude-code' {
  interface PluginState {
    'qs': {
      /** Every OPEN ask in the db, all folders. */
      asks: Ask[]
      here: AskHere | null
      /** Per-session switch: true after `/qs off`. */
      isOff: boolean
      tab: AskTab
      /** The session's title, when the engine reports one. */
      title: string
      /** The last db error, '' when the last refresh worked. */
      error: string
    }
  }
}
