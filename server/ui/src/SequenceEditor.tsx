import { useEffect, useState } from 'react'
import type { HttpSequence, HttpResponseStep } from './state'
import { HeadersEditor } from './MocksView'

export function SequenceEditor({ deviceId, ruleId, value, onChange }: { deviceId: string; ruleId: string; value: HttpSequence; onChange: (value: HttpSequence) => void }) {
  const [progress, setProgress] = useState('Waiting for device sync')
  useEffect(() => {
    let active = true
    const check = async () => {
      try {
        const response = await fetch(`/api/mock-progress?${new URLSearchParams({ deviceId, ruleId })}`)
        if (!response.ok) throw new Error()
        const state = await response.json()
        const hit = state.hits?.filter((h: { revision: string; stepIndex?: number }) => h.revision === state.revision && h.stepIndex != null).at(-1)
        if (active) setProgress(!state.connected ? 'Device offline' : !state.supported ? 'Update SDK to use sequences' : !state.ready ? 'Waiting for device sync' : hit ? `Last matched: step ${hit.stepIndex + 1}` : 'Ready / no hits in this sync')
      } catch { if (active) setProgress('Progress unavailable') }
    }
    void check(); const timer = setInterval(check, 1000)
    return () => { active = false; clearInterval(timer) }
  }, [deviceId, ruleId, value.resetToken])
  const [selected, setSelected] = useState(0)
  const [reset, setReset] = useState(false)
  const index = Math.min(selected, value.steps.length - 1)
  const step = { status: 200, headers: {}, body: '', delayMs: 0, ...(value.steps[index] as Partial<HttpResponseStep>) }
  const update = (patch: Partial<HttpResponseStep>) => onChange({ ...value, steps: value.steps.map((s, i) => i === index ? { ...s, ...patch } : s) })
  const move = (offset: number) => {
    const steps = [...value.steps]; const target = index + offset
    ;[steps[index], steps[target]] = [steps[target], steps[index]]
    onChange({ ...value, steps }); setSelected(target)
  }
  return <>
    <p className="hint" role="status">{progress}</p>
    <div className="sequence-controls">
      <label className="field">After last step <select value={value.onExhausted ?? 'last'} onChange={e => onChange({ ...value, onExhausted: e.target.value as HttpSequence['onExhausted'] })}>
        <option value="last">Repeat last step</option><option value="loop">Start over</option><option value="stop">Fail further requests</option>
      </select></label>
      <button onClick={() => { onChange({ ...value, resetToken: crypto.randomUUID() }); setReset(true) }}>Reset progress</button>
      {reset && <span className="hint" role="status">Reset queued for device sync.</span>}
    </div>
    <p className="hint">Only matching requests consume a step. Background requests using this rule count too. Changes restart the sequence.</p>
    <div className="sequence-editor">
      <div className="sequence-list" role="group" aria-label="Response steps">
        {value.steps.map((s, i) => <button key={i} aria-pressed={i === index} onClick={() => setSelected(i)}><strong>Step {i + 1}</strong><span>{s.status ?? 200} / {s.delayMs ?? 0} ms</span></button>)}
        <button disabled={value.steps.length >= 100} onClick={() => { onChange({ ...value, steps: [...value.steps, { status: 200, body: '{}', headers: {}, delayMs: 0 }] }); setSelected(value.steps.length) }}>Add step</button>
      </div>
      <div className="sequence-detail">
        <div className="sequence-controls"><strong>Step {index + 1}</strong><span className="spacer" />
          <button disabled={index === 0} onClick={() => move(-1)}>Move up</button><button disabled={index === value.steps.length - 1} onClick={() => move(1)}>Move down</button>
          <button disabled={value.steps.length === 1} onClick={() => onChange({ ...value, steps: value.steps.filter((_, i) => i !== index) })}>Remove</button>
        </div>
        <div className="sequence-controls">
          <label className="field">Status <input className="w-status" type="number" min="100" max="599" value={step.status} onChange={e => { const n = Number(e.target.value); if (n >= 100 && n <= 599 && Number.isInteger(n)) update({ status: n }) }} /></label>
          <label className="field">Delay ms <input className="w-delay" type="number" min="0" max="300000" value={step.delayMs} onChange={e => { const n = Number(e.target.value); if (n >= 0 && n <= 300000 && Number.isInteger(n)) update({ delayMs: n }) }} /></label>
        </div>
        <label className="field">Response body</label>
        <textarea className="mono rule-response-editor" rows={14} aria-label="Step response body" value={step.body} onChange={e => update({ body: e.target.value })} />
        <details><summary>Response headers</summary><HeadersEditor key={index} value={step.headers} onChange={headers => update({ headers })} /></details>
      </div>
    </div>
  </>
}
