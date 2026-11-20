// asks (claude-asks repo): the state contract. The db (an artifact's `asks` collection)
// is the truth; this is the session's cache of it, so drawing is synchronous.

export type AskKind = 'do' | 'decide' | 'answer'
export type AskStatus = 'open' | 'done' | 'dismissed'

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
}

/** Where this session is: what the band and the Session/Folder tabs filter on. */
export type AskHere = { sessionId: string; folder: string }

export type AskTab = 'session' | 'folder' | 'all'

declare module 'claude-code' {
  interface PluginState {
    'asks': {
      /** Every OPEN ask in the db, all folders. */
      asks: Ask[]
      here: AskHere | null
      /** Per-session switch: true after `/asks off`. */
      isOff: boolean
      tab: AskTab
      /** The session's title, when the engine reports one. */
      title: string
      /** The last db error, '' when the last refresh worked. */
      error: string
    }
  }
}
