import type { Mocks } from './state.js'

export type PushEventRule = {
  id: string
  target: string
  /** endpoint of the target connection, so the record survives a reconnect (see pushTarget.ts) */
  targetEndpoint?: string
  event: string
  payload: string
  name?: string
  starred?: boolean
}

export type ExportRulesSource = Mocks & {
  push: PushEventRule[]
}

export type ExportRuleSelection = {
  http: boolean
  socket: boolean
  push: boolean
}

export function createFullExportSelection(source: ExportRulesSource): ExportRuleSelection {
  return {
    http: true,
    socket: true,
    push: true,
  }
}

export function buildExportRules(source: ExportRulesSource, selection: ExportRuleSelection): ExportRulesSource {
  return {
    http: selection.http ? source.http : [],
    socket: selection.socket ? source.socket : [],
    push: selection.push ? source.push : [],
  }
}

export function countSelectedRules(selection: ExportRuleSelection): number {
  return Number(selection.http) + Number(selection.socket) + Number(selection.push)
}

/** Parse an exported rules file. Returns null when the text is not a rules JSON object.
    Reads every category [buildExportRules] writes -- a category exported but not parsed
    here vanishes on import (see the symmetry assertion in the tests). */
export function parseImportedRules(text: string): ExportRulesSource | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const source = parsed as Partial<ExportRulesSource>
  const list = <T>(value: T[] | undefined): T[] => Array.isArray(value) ? value : []
  return { http: list(source.http), socket: list(source.socket), push: list(source.push) }
}

export function countImportedRules(source: ExportRulesSource): number {
  return source.http.length + source.socket.length + source.push.length
}

/** Imported rules re-enter as fresh copies: new ids, so importing the same file twice appends
    instead of colliding with what is already there. The star is dropped -- it means "share with
    every device of this app", and an import lands on the device doing the importing; spreading
    it app-wide stays an explicit one-click decision. */
export function importedCopies<T extends { id: string; starred?: boolean }>(
  rules: T[],
  newId: () => string,
): T[] {
  return rules.map(r => ({ ...r, id: newId(), starred: undefined }))
}
