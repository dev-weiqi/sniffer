import { randomUUID } from 'node:crypto'
import type { Mocks } from './mockStore.js'

/** Session-bound acknowledgements: a reconnect or newer send invalidates earlier ACKs. */
export function createMockSync() {
  const states = new Map<string, { revision: string; acknowledged: boolean; ruleIds: string[] }>()
  const hits: Array<{ deviceId: string; ruleId: string; revision: string; timestamp: number }> = []
  return {
    sent(deviceId: string, mocks: Mocks) {
      const revision = randomUUID()
      states.set(deviceId, { revision, acknowledged: false, ruleIds: [...mocks.http, ...mocks.socket].map(r => (r as { id: string }).id) })
      return revision
    },
    disconnect(deviceId: string) { states.delete(deviceId) },
    receive(deviceId: string, msg: Record<string, unknown>) {
      const state = states.get(deviceId)
      if (!state || msg.revision !== state.revision) return
      if (msg.type === 'mock-rules-applied') state.acknowledged = true
      if (msg.type === 'mock-hit' && typeof msg.ruleId === 'string' && state.ruleIds.includes(msg.ruleId)) {
        hits.push({ deviceId, ruleId: msg.ruleId, revision: state.revision, timestamp: Date.now() })
        if (hits.length > 1000) hits.shift()
      }
    },
    status(deviceId: string, ruleIds: string[], ended: boolean) {
      const state = states.get(deviceId)
      const omitted = ruleIds.filter(id => !state?.ruleIds.includes(id))
      return { revision: state?.revision ?? null, acknowledged: state?.acknowledged ?? false,
        ready: !!state?.acknowledged && (ended ? omitted.length === ruleIds.length : omitted.length === 0),
        omittedRuleIds: omitted, hits: hits.filter(h => h.deviceId === deviceId && ruleIds.includes(h.ruleId)),
        evidenceLimit: 1000 }
    },
  }
}
