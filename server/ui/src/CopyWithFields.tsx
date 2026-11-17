import { useRef, useState } from 'react'

/** Preview edits against the current draft; saving still uses the existing rule-copy flow. */
export function CopyWithFields({ body, onCopy }: { body: string; onCopy: (body: string) => void }) {
  const [path, setPath] = useState('')
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{ key: string; body: string; before: unknown; after: unknown } | null>(null)
  const request = useRef(0)
  const key = JSON.stringify([body, path, value])
  const current = preview?.key === key ? preview : null
  const show = (v: unknown) => JSON.stringify(v, null, 2)
  async function inspect() {
    const generation = ++request.current
    setError('')
    setPreview(null)
    setBusy(true)
    try {
      let parsed: unknown
      try { parsed = JSON.parse(value) } catch { throw new Error('Enter a JSON value: 36, true, null, or "text".') }
      const res = await fetch('/api/mock-body/replace-fields', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body, replacements: [{ path, value: parsed }] }),
      })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error || 'Could not preview field replacement')
      if (request.current === generation) setPreview({ key, body: result.body,
        before: result.changes[0].before, after: result.changes[0].after })
    } catch (e) {
      if (request.current === generation) setError(e instanceof Error ? e.message : 'Could not preview field replacement')
    } finally {
      if (request.current === generation) setBusy(false)
    }
  }
  return <details className="copy-fields">
    <summary>Copy with field changes</summary>
    <p className="hint">Replace an existing JSON field in a disabled, unshared copy. The original stays unchanged.</p>
    <div className="copy-fields-inputs">
      <label>Field path (JSON Pointer)<input value={path} placeholder="/data/commentCount"
        onChange={e => { setPath(e.target.value); setError(''); setPreview(null) }} /></label>
      <label>New value (JSON)<input value={value} placeholder="36"
        onChange={e => { setValue(e.target.value); setError(''); setPreview(null) }} /></label>
      <button type="button" disabled={busy || !path || !value} onClick={inspect}>{busy ? 'Checking…' : 'Preview change'}</button>
    </div>
    <p className="hint">Use /items/0/name for arrays; escape / as ~1 and ~ as ~0 in field names. Existing types are preserved.</p>
    {error && <p role="alert" className="copy-fields-error">{error}</p>}
    {current && <div aria-live="polite">
      <div className="copy-fields-diff"><div><strong>Before</strong><pre>{show(current.before)}</pre></div>
        <div><strong>After</strong><pre>{show(current.after)}</pre></div></div>
      <button type="button" onClick={() => onCopy(current.body)}>Create disabled copy</button>
    </div>}
  </details>
}
