import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { HttpMockRule, HttpRow, PausedHit } from './state'
import { copyText, fmtDuration, fmtSize, fmtTime, prettyJson, splitHighlight, splitLinks, statusClass, toCurl, urlParts } from './util'
import { newRuleId } from './util'
import { useDetailWidth, useListKeys } from './hooks'
import { JsonView } from './JsonView'
import { HeadersEditor } from './MocksView'
import { base64ToBytes, formatWebpSummary, parseWebpAnimation, type WebpAnimationInfo } from './webp'

export type ResolveEdits = { status?: number; headers?: Record<string, string>; body?: string }

function isSse(row: HttpRow): boolean {
  return (row.respHeaders?.['content-type'] ?? '').includes('event-stream')
}

function imageContentType(row: HttpRow): string | null {
  // the SDK base64-encodes bodies only for image captures, so respBase64 alone means "image";
  // the header is just a hint (servers send Content-Type casing variants or even image/*)
  if (!row.respBase64) return null
  const key = Object.keys(row.respHeaders ?? {}).find(k => k.toLowerCase() === 'content-type')
  const ct = (key ? row.respHeaders![key] : '').split(';')[0].trim().toLowerCase()
  if (ct.startsWith('image/') && !ct.includes('*')) return ct
  return sniffImageMime(row.respBody ?? '')
}

/** Magic-byte sniffing for when the Content-Type header is unusable. */
function sniffImageMime(base64: string): string {
  if (base64.startsWith('iVBOR')) return 'image/png'
  if (base64.startsWith('/9j/')) return 'image/jpeg'
  if (base64.startsWith('R0lGOD')) return 'image/gif'
  if (base64.startsWith('UklGR')) return 'image/webp'
  return 'image/png'
}

export function HttpView({ rows, query, pausedHits, armedCount, onMock, onArm, onResolve, onDisarmAll, onClear }: {
  rows: HttpRow[]
  query: string
  pausedHits: PausedHit[]
  armedCount: number
  onMock: (rule: HttpMockRule, deviceId: string) => void
  onArm: (row: HttpRow) => void
  onResolve: (hit: PausedHit, action: 'resume' | 'abort', edits?: ResolveEdits) => void
  onDisarmAll: () => void
  onClear: () => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sortDesc, setSortDesc] = useState(false)
  const selectedHit = pausedHits.find(h => h.id === selectedId) ?? null
  const selected = rows.find(r => r.id === selectedId) ?? null
  const listRef = useRef<HTMLDivElement>(null)
  const stickBottom = useRef(true)

  // a paused hit shares its request's id, so mark that row as blocked in place rather than
  // showing a duplicate. Only hits with no row yet (e.g. after Clear) get pinned to the top.
  const pausedById = useMemo(() => new Map(pausedHits.map(h => [h.id, h])), [pausedHits])
  const orphanHits = useMemo(() => pausedHits.filter(h => !rows.some(r => r.id === h.id)), [pausedHits, rows])

  // rows arrive in chronological order; reversing yields newest-first
  const sorted = useMemo(() => (sortDesc ? [...rows].reverse() : rows), [rows, sortDesc])
  const ids = useMemo(() => sorted.map(r => r.id), [sorted])
  useListKeys(ids, selectedId, setSelectedId)
  const [detailWidth, startDetailDrag] = useDetailWidth()

  useEffect(() => {
    const el = listRef.current
    if (el && !sortDesc && stickBottom.current && !selectedId) el.scrollTop = el.scrollHeight
  }, [rows.length, selectedId, sortDesc])

  // debugger-style focus: jump to a freshly paused response, and after resolving the selected one
  // jump to the next still-paused response so you can work through them.
  const seenHitIds = useRef<Set<string>>(new Set())
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  useEffect(() => {
    const prev = seenHitIds.current
    const current = new Set(pausedHits.map(h => h.id))
    seenHitIds.current = current
    const cur = selectedIdRef.current
    const fresh = pausedHits.find(h => !prev.has(h.id))
    const nextAfterResolve = cur && prev.has(cur) && !current.has(cur) && pausedHits.length > 0 ? pausedHits[0] : null
    const target = fresh ?? nextAfterResolve
    if (!target) return
    setSelectedId(target.id)
    requestAnimationFrame(() => {
      listRef.current?.querySelector('tr[data-selected]')?.scrollIntoView({ block: 'nearest' })
    })
  }, [pausedHits])

  return (
    <div className="split" style={{ ['--detail-w' as string]: `${detailWidth}px` }}>
      <div className="list-pane">
        <div className="panel-toolbar">
          <span className="dim">API traffic</span>
          {pausedHits.length > 0 && <span className="badge bp-paused bp-blink">⏸ {pausedHits.length} paused</span>}
          {armedCount > 0 && (
            <button className="badge bp-armed" title="Disarm all breakpoints" onClick={onDisarmAll}>
              ⏸ {armedCount} armed ✕
            </button>
          )}
          <span className="spacer" />
          <button className="clear-btn" disabled={rows.length === 0} onClick={onClear}>Clear API</button>
        </div>
        <div
          className="list-scroll"
          ref={listRef}
          onScroll={e => {
            const el = e.currentTarget
            stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
        >
        <table className="grid">
          <thead>
            <tr>
              <th style={{ width: 90 }} className="sortable" onClick={() => setSortDesc(d => !d)}>
                Time {sortDesc ? '↓' : '↑'}
              </th>
              <th style={{ width: 62 }}>Method</th>
              <th style={{ width: 52 }}>Status</th>
              <th>URL</th>
              <th style={{ width: 66 }} className="num">Size</th>
              <th style={{ width: 70 }} className="num">Time</th>
            </tr>
          </thead>
          <tbody>
            {orphanHits.map(h => (
              <PausedRowItem key={h.id} hit={h} selected={h.id === selectedId} onSelect={setSelectedId} />
            ))}
            {sorted.map(r => (
              <HttpRowItem key={r.id} row={r} query={query} paused={pausedById.has(r.id)}
                selected={r.id === selectedId} onSelect={setSelectedId} />
            ))}
          </tbody>
        </table>
        {rows.length === 0 && pausedHits.length === 0 && <div className="empty">No requests yet — traffic appears live once the app starts</div>}
        </div>
      </div>

      {(selected || selectedHit) && <div className="pane-resizer" onMouseDown={startDetailDrag} />}
      {selectedHit
        ? <PausedDetail hit={selectedHit} onResolve={onResolve} onClose={() => setSelectedId(null)} />
        : selected && <HttpDetail row={selected} query={query} onMock={onMock} onArm={onArm} onClose={() => setSelectedId(null)} />}
    </div>
  )
}

// a response paused on the device, pinned above live traffic until the user resolves it
const PausedRowItem = memo(function PausedRowItem({ hit, selected, onSelect }: {
  hit: PausedHit
  selected: boolean
  onSelect: (id: string | null) => void
}) {
  const { domain, path } = urlParts(hit.url)
  return (
    <tr className="bp-row" data-selected={selected || undefined}
      onClick={() => onSelect(selected ? null : hit.id)}>
      <td className="mono dim">{fmtTime(hit.timestamp)}</td>
      <td className="mono method">{hit.method}</td>
      <td className="mono"><span className="bp-dot" /></td>
      <td className="url-cell">
        <span className="badge bp-paused">PAUSED</span>
        <span className="dim">{domain}</span>
        <span>{path}</span>
      </td>
      <td className="mono num dim" />
      <td className="mono num dim">…</td>
    </tr>
  )
})

// memoized: only the rows whose data or selection changed re-render as traffic streams in
const HttpRowItem = memo(function HttpRowItem({ row: r, query, paused, selected, onSelect }: {
  row: HttpRow
  query: string
  paused: boolean
  selected: boolean
  onSelect: (id: string | null) => void
}) {
  const { domain, path } = urlParts(r.url)
  return (
    <tr className={paused ? 'bp-row' : undefined} data-selected={selected || undefined}
      onClick={() => onSelect(selected ? null : r.id)}>
      <td className="mono dim">{fmtTime(r.ts)}</td>
      <td className="mono method"><Highlight text={r.method} query={query} /></td>
      <td className={`mono ${statusClass(r.status, r.error)}`}>
        {paused ? <span className="bp-dot" /> : r.status === 0 ? 'ERR' : r.status ?? '…'}
      </td>
      <td className="url-cell">
        {paused && <span className="badge bp-paused">PAUSED</span>}
        {r.mocked && <span className="badge mock">MOCK</span>}
        {!r.mocked && (r.delayedMs ?? 0) > 0 && <span className="badge delay">DELAY</span>}
        <span className="dim"><Highlight text={domain} query={query} /></span>
        <span><Highlight text={path} query={query} /></span>
      </td>
      <td className="mono num dim">{fmtSize(r.respSize)}</td>
      <td className="mono num dim">{fmtDuration(r.durationMs)}</td>
    </tr>
  )
})

function HttpDetail({ row, query, onMock, onArm, onClose }: {
  row: HttpRow
  query: string
  onMock: (rule: HttpMockRule, deviceId: string) => void
  onArm: (row: HttpRow) => void
  onClose: () => void
}) {
  const { query: queryParams } = urlParts(row.url)
  const [copied, setCopied] = useState(false)

  const copyCurl = () => {
    copyText(toCurl(row))
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  const mockThis = () => onMock(
    {
      id: newRuleId(), enabled: true, method: row.method,
      // full URL: contains-matching on a bare path would also hit other hosts / query variants
      urlPattern: row.url, status: row.status && row.status > 0 ? row.status : 200,
      headers: { 'content-type': row.respHeaders?.['content-type'] ?? 'application/json' },
      body: row.respBody ?? '', delayMs: 0, delayOnly: false,
    },
    row.deviceId,
  )

  return (
    <aside className="detail-pane">
      <div className="detail-toolbar">
        <button onClick={copyCurl}>{copied ? 'Copied ✓' : 'Copy cURL'}</button>
        <button onClick={mockThis}>Mock this request</button>
        <button title="Pause future responses to this path so you can edit them before the app sees them"
          onClick={() => onArm(row)}>⏸ Break on this</button>
        <span className="spacer" />
        <button className="ghost" onClick={onClose}>✕</button>
      </div>

      <Section title="Request">
        <KV k="URL" v={row.url} query={query} />
        <KV k="Method" v={row.method} query={query} />
        <KV k="Library" v={row.library} />
        {row.durationMs !== undefined && <KV k="Duration" v={fmtDuration(row.durationMs)} />}
        {(row.delayedMs ?? 0) > 0 && <KV k="Delayed" v={`+${row.delayedMs} ms injected by a delay-only rule`} />}
        {row.mocked && <KV k="Mocked" v="yes (short-circuited on device, no network)" />}
        {row.error && <KV k="Error" v={row.error} />}
      </Section>

      {queryParams.length > 0 && (
        <Section title="Query">
          {queryParams.map(([k, v], i) => <KV key={i} k={k} v={v} query={query} />)}
        </Section>
      )}

      <Section title="Request Headers">
        {Object.entries(row.reqHeaders).map(([k, v]) => <KV key={k} k={k} v={v} />)}
      </Section>

      {row.reqBody && (
        <Section title="Request Body" action={<CopyButton text={row.reqBody} />}>
          <JsonView text={row.reqBody} query={query} />
        </Section>
      )}

      {row.respHeaders && (
        <Section title="Response Headers">
          {Object.entries(row.respHeaders).map(([k, v]) => <KV key={k} k={k} v={v} />)}
        </Section>
      )}

      <Section title="Response Body" action={row.respBody ? <CopyButton text={row.respBody} /> : null}>
        {row.respBody
          ? (row.respBase64 && imageContentType(row)
              ? <ImagePreview contentType={imageContentType(row)!} base64={row.respBody} />
              : isSse(row) ? <pre className="body-pre"><Highlight text={row.respBody} query={query} /></pre> : <JsonView text={row.respBody} query={query} />)
          : <div className="dim pad">
              {row.status === undefined ? 'Waiting for response…'
                : isSse(row) ? 'SSE stream — events appear here as the app reads them'
                : '(empty or binary)'}
            </div>}
      </Section>
    </aside>
  )
}

function isValidJson(text: string): boolean {
  if (!text.trim()) return false
  try { JSON.parse(text); return true } catch { return false }
}

/** Editor for a paused (response-phase) breakpoint: edit the response then resume, or abort. */
function PausedDetail({ hit, onResolve, onClose }: {
  hit: PausedHit
  onResolve: (hit: PausedHit, action: 'resume' | 'abort', edits?: ResolveEdits) => void
  onClose: () => void
}) {
  const [status, setStatus] = useState(String(hit.status))
  const [headers, setHeaders] = useState<Record<string, string>>(hit.headers)
  const [body, setBody] = useState(hit.body ?? '')
  const bodyIsJson = isValidJson(body)
  const { domain, path } = urlParts(hit.url)

  return (
    <aside className="detail-pane">
      <div className="detail-toolbar">
        <span className="badge bp-paused bp-blink">⏸ PAUSED</span>
        <span className="dim">{hit.library}</span>
        <span className="spacer" />
        <button className="ghost" onClick={onClose}>✕</button>
      </div>
      <div className="bp-editor">
        <div className="dim bp-hint">
          Response held — edits apply before the app sees it. The app is blocked until you act.
        </div>
        <div className="mono dim bp-target">{hit.method} {domain}{path}</div>
        <label className="bp-label">Status</label>
        <input className="bp-method mono" value={status} onChange={e => setStatus(e.target.value)} />
        <label className="bp-label">Response headers</label>
        <HeadersEditor value={headers} onChange={setHeaders} />
        <label className="bp-label bp-label-row">
          <span>Response body{body.trim() && !bodyIsJson && <span className="bp-invalid"> · invalid JSON</span>}</span>
          <button className="ghost bp-beautify" disabled={!bodyIsJson}
            title={bodyIsJson ? 'Format JSON' : 'Body is not valid JSON'}
            onClick={() => setBody(prettyJson(body))}>Pretty JSON</button>
        </label>
        <textarea className="bp-ta mono" rows={10} value={body} onChange={e => setBody(e.target.value)} />
        <div className="bp-actions">
          <button className="bp-btn primary"
            onClick={() => onResolve(hit, 'resume', { status: Number(status) || hit.status, headers, body })}>
            Resume with edits
          </button>
          <button className="bp-btn" onClick={() => onResolve(hit, 'resume')}>Resume unchanged</button>
          <span className="spacer" />
          <button className="bp-btn danger" onClick={() => onResolve(hit, 'abort')}>Abort</button>
        </div>
      </div>
    </aside>
  )
}

function ImagePreview({ contentType, base64 }: { contentType: string; base64: string }) {
  const [dims, setDims] = useState<string | null>(null)
  const src = `data:${contentType};base64,${base64}`
  const webpInfo = contentType === 'image/webp' ? parseWebpAnimation(base64) : null
  if (webpInfo?.animated) {
    return <WebpPlayer src={src} base64={base64} info={webpInfo} />
  }
  return (
    <div className="image-preview">
      <img className="body-image" alt="response" src={src}
        onLoad={e => setDims(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)} />
      {dims && <div className="dim hint">{dims}</div>}
    </div>
  )
}

function WebpPlayer({ src, base64, info }: { src: string; base64: string; info: WebpAnimationInfo }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const snapshotRef = useRef<HTMLCanvasElement>(null)
  const [frames, setFrames] = useState<ImageBitmap[]>([])
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(true)
  const supported = 'ImageDecoder' in window

  useEffect(() => {
    if (!supported) return
    let cancelled = false
    let decoded: ImageBitmap[] = []
    ;(async () => {
      const Decoder = (window as unknown as {
        // ImageDecoder accepts BufferSource/ReadableStream — a Blob throws TypeError at construction
        ImageDecoder: new (init: { data: Uint8Array; type: string }) => ImageDecoderLike
      }).ImageDecoder
      const decoder = new Decoder({ data: base64ToBytes(base64), type: 'image/webp' })
      const nextFrames: ImageBitmap[] = []
      for (let i = 0; i < info.frames; i++) {
        const result = await decoder.decode({ frameIndex: i })
        nextFrames.push(result.image)
      }
      decoded = nextFrames
      if (!cancelled) setFrames(nextFrames)
      decoder.close?.()
    })().catch(() => {
      if (!cancelled) setFrames([])
      for (const frame of decoded) frame.close()
    })
    return () => {
      cancelled = true
      for (const frame of decoded) frame.close()
    }
  }, [base64, info.frames, supported])

  useEffect(() => {
    const canvas = canvasRef.current
    const frame = frames[index]
    if (!canvas || !frame) return
    // ImageDecoder yields VideoFrames, which size via displayWidth/Height (width is undefined)
    const f = frame as unknown as { width?: number; height?: number; displayWidth?: number; displayHeight?: number }
    const w = f.displayWidth ?? f.width ?? 0
    const h = f.displayHeight ?? f.height ?? 0
    if (!w || !h) return
    canvas.width = w
    canvas.height = h
    canvas.getContext('2d')?.drawImage(frame as unknown as CanvasImageSource, 0, 0)
  }, [frames, index])

  useEffect(() => {
    if (!playing || frames.length <= 1) return
    const stepMs = Math.max(20, Math.round(info.durationMs / Math.max(1, info.frames)))
    const timer = setTimeout(() => setIndex(i => (i + 1) % frames.length), stepMs)
    return () => clearTimeout(timer)
  }, [frames.length, index, info.durationMs, info.frames, playing])

  const captureNativeFrame = () => {
    const img = imgRef.current
    const canvas = snapshotRef.current
    if (!img || !canvas || img.naturalWidth === 0 || img.naturalHeight === 0) return
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    canvas.getContext('2d')?.drawImage(img, 0, 0)
  }

  const togglePlaying = () => {
    if (frames.length > 0) {
      setPlaying(p => !p)
      return
    }
    if (playing) captureNativeFrame()
    setPlaying(p => !p)
  }

  const summary = formatWebpSummary(info)

  return (
    <div className="webp-player">
      {frames.length > 0 ? (
        <canvas ref={canvasRef} className="body-image" />
      ) : (
        <>
          <img ref={imgRef} className="body-image" alt="response" src={src}
            style={{ display: playing ? 'block' : 'none' }} />
          <canvas ref={snapshotRef} className="body-image" style={{ display: playing ? 'none' : 'block' }} />
        </>
      )}
      <div className="webp-controls">
        <button className="pill-btn" onClick={togglePlaying}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <input type="range" min={0} max={Math.max(0, info.frames - 1)} value={index}
          disabled={!supported || frames.length === 0}
          onChange={e => { setPlaying(false); setIndex(Number(e.target.value)) }} />
        <span className="mono dim">{frames.length > 0 ? `${Math.min(index + 1, info.frames)} / ${info.frames}` : `${info.frames} frames`}</span>
      </div>
      <div className="dim hint">{frames.length > 0 ? summary : `${summary} · pause uses a rendered-frame snapshot`}</div>
    </div>
  )
}

interface ImageDecoderLike {
  decode(init: { frameIndex: number }): Promise<{ image: ImageBitmap }>
  close?: () => void
}

export function Section({ title, action, children }: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <section className="detail-section">
      <h3 onClick={() => setOpen(!open)}>
        <span className="chev" data-open={open || undefined}>▸</span> {title}
        {action && <span className="section-action" onClick={e => e.stopPropagation()}>{action}</span>}
      </h3>
      {open && children}
    </section>
  )
}

/** JSON bodies copy pretty-printed; anything else copies verbatim. */
function prettyIfJson(t: string): string {
  try { return JSON.stringify(JSON.parse(t), null, 2) } catch { return t }
}

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="ghost copy-btn"
      onClick={() => {
        copyText(prettyIfJson(text))
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? 'Copied ✓' : 'Copy'}
    </button>
  )
}

/** Wraps query matches in <mark> so search hits are visible in place. */
export function Highlight({ text, query }: { text: string; query: string }) {
  return <>{splitHighlight(text, query).map((s, i) => s.match ? <mark key={i} className="hl">{s.text}</mark> : s.text)}</>
}

// Same as Highlight, but http(s) URLs inside the text become clickable links.
export function LinkText({ text, query }: { text: string; query: string }) {
  return <>{splitLinks(text).map((s, i) => s.link
    ? <a key={i} className="jn-link" href={s.text} target="_blank" rel="noreferrer noopener"><Highlight text={s.text} query={query} /></a>
    : <Highlight key={i} text={s.text} query={query} />)}</>
}

export function KV({ k, v, query = '' }: { k: string; v: string; query?: string }) {
  return (
    <div className="kv">
      <span className="kv-k">{k}</span>
      <span className="kv-v mono"><Highlight text={v} query={query} /></span>
    </div>
  )
}
