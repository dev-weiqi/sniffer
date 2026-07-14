import type { Mocks } from './state.js'

export type PushEventRule = {
  id: string
  target: string
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
