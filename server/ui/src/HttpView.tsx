import { useEffect, useMemo, useRef, useState } from 'react'
import type { HttpMockRule, HttpRow } from './state'
import { copyText, fmtDuration, fmtSize, fmtTime, statusClass, toCurl, urlParts, useDetailWidth, useListKeys } from './util'
import { newRuleId } from './util'
import { JsonView } from './JsonView'

function isSse(row: HttpRow): boolean {
  return (row.respHeaders?.['content-type'] ?? '').includes('event-stream')
}

function imageContentType(row: HttpRow): string | null {
  const ct = row.respHeaders?.['content-type'] ?? ''
  return ct.trim().toLowerCase().startsWith('image/') ? ct.split(';')[0].trim() : null
}

export function HttpView({ rows, onMock, onClear }: {
  rows: HttpRow[]
  onMock: (rule: HttpMockRule, deviceId: string) => void
  onClear: () => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sortDesc, setSortDesc] = useState(false)
  const selected = rows.find(r => r.id === selectedId) ?? null
  const listRef = useRef<HTMLDivElement>(null)
  const stickBottom = useRef(true)

  // rows arrive in chronological order; reversing yields newest-first
  const sorted = useMemo(() => (sortDesc ? [...rows].reverse() : rows), [rows, sortDesc])
  const ids = useMemo(() => sorted.map(r => r.id), [sorted])
  useListKeys(ids, selectedId, setSelectedId)
  const [detailWidth, startDetailDrag] = useDetailWidth()

  useEffect(() => {
    const el = listRef.current
    if (el && !sortDesc && stickBottom.current && !selectedId) el.scrollTop = el.scrollHeight
  }, [rows.length, selectedId, sortDesc])

  return (
    <div className="split" style={{ ['--detail-w' as string]: `${detailWidth}px` }}>
      <div className="list-pane">
        <div className="panel-toolbar">
          <span className="dim">API traffic</span>
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
            {sorted.map(r => {
              const { domain, path } = urlParts(r.url)
              return (
                <tr key={r.id} data-selected={r.id === selectedId || undefined}
                  onClick={() => setSelectedId(r.id === selectedId ? null : r.id)}>
                  <td className="mono dim">{fmtTime(r.ts)}</td>
                  <td className="mono method">{r.method}</td>
                  <td className={`mono ${statusClass(r.status, r.error)}`}>
                    {r.status === 0 ? 'ERR' : r.status ?? '…'}
                  </td>
                  <td className="url-cell">
                    {r.mocked && <span className="badge mock">MOCK</span>}
                    {!r.mocked && (r.delayedMs ?? 0) > 0 && <span className="badge delay">DELAY</span>}
                    <span className="dim">{domain}</span>
                    <span>{path}</span>
                  </td>
                  <td className="mono num dim">{fmtSize(r.respSize)}</td>
                  <td className="mono num dim">{fmtDuration(r.durationMs)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {rows.length === 0 && <div className="empty">No requests yet — traffic appears live once the app starts</div>}
        </div>
      </div>

      {selected && <div className="pane-resizer" onMouseDown={startDetailDrag} />}
      {selected && <HttpDetail row={selected} onMock={onMock} onClose={() => setSelectedId(null)} />}
    </div>
  )
}

function HttpDetail({ row, onMock, onClose }: {
  row: HttpRow
  onMock: (rule: HttpMockRule, deviceId: string) => void
  onClose: () => void
}) {
  const { query } = urlParts(row.url)
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
        <span className="spacer" />
        <button className="ghost" onClick={onClose}>✕</button>
      </div>

      <Section title="Request">
        <KV k="URL" v={row.url} />
        <KV k="Method" v={row.method} />
        <KV k="Library" v={row.library} />
        {row.durationMs !== undefined && <KV k="Duration" v={fmtDuration(row.durationMs)} />}
        {(row.delayedMs ?? 0) > 0 && <KV k="Delayed" v={`+${row.delayedMs} ms injected by a delay-only rule`} />}
        {row.mocked && <KV k="Mocked" v="yes (short-circuited on device, no network)" />}
        {row.error && <KV k="Error" v={row.error} />}
      </Section>

      {query.length > 0 && (
        <Section title="Query">
          {query.map(([k, v], i) => <KV key={i} k={k} v={v} />)}
        </Section>
      )}

      <Section title="Request Headers">
        {Object.entries(row.reqHeaders).map(([k, v]) => <KV key={k} k={k} v={v} />)}
      </Section>

      {row.reqBody && (
        <Section title="Request Body">
          <JsonView text={row.reqBody} />
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
              : isSse(row) ? <pre className="body-pre">{row.respBody}</pre> : <JsonView text={row.respBody} />)
          : <div className="dim pad">
              {row.status === undefined ? 'Waiting for response…'
                : isSse(row) ? 'SSE stream — events appear here as the app reads them'
                : '(empty or binary)'}
            </div>}
      </Section>
    </aside>
  )
}

function ImagePreview({ contentType, base64 }: { contentType: string; base64: string }) {
  const src = `data:${contentType};base64,${base64}`
  const webpInfo = contentType === 'image/webp' ? parseWebpAnimation(base64) : null
  if (webpInfo?.animated) {
    return <WebpPlayer src={src} base64={base64} info={webpInfo} />
  }
  return <img className="body-image" alt="response" src={src} />
}

interface WebpAnimationInfo {
  animated: boolean
  frames: number
  durationMs: number
  loopCount: number
  canvasWidth?: number
  canvasHeight?: number
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

  const summary = `${info.frames} frames · ${fmtDuration(info.durationMs)} · ${info.loopCount === 0 ? 'infinite loop' : `${info.loopCount} loops`}`

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

function parseWebpAnimation(base64: string): WebpAnimationInfo | null {
  const bytes = base64ToBytes(base64)
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return null
  let loopCount = 0
  let frames = 0
  let durationMs = 0
  let canvasWidth: number | undefined
  let canvasHeight: number | undefined

  for (let offset = 12; offset + 8 <= bytes.length;) {
    const fourcc = ascii(bytes, offset, 4)
    const size = readUint32LE(bytes, offset + 4)
    const payload = offset + 8
    if (payload + size > bytes.length) break

    if (fourcc === 'VP8X' && size >= 10) {
      canvasWidth = readUint24LE(bytes, payload + 4) + 1
      canvasHeight = readUint24LE(bytes, payload + 7) + 1
    } else if (fourcc === 'ANIM' && size >= 6) {
      loopCount = bytes[payload + 4] | (bytes[payload + 5] << 8)
    } else if (fourcc === 'ANMF' && size >= 16) {
      frames += 1
      durationMs += readUint24LE(bytes, payload + 12)
    }

    offset = payload + size + (size % 2)
  }

  return frames > 0
    ? { animated: true, frames, durationMs, loopCount, canvasWidth, canvasHeight }
    : { animated: false, frames: 1, durationMs: 0, loopCount: 0, canvasWidth, canvasHeight }
}

function base64ToBlob(base64: string, type: string): Blob {
  const bytes = base64ToBytes(base64)
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  return new Blob([copy.buffer], { type })
}

function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length))
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)
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

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="ghost copy-btn"
      onClick={() => {
        copyText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? 'Copied ✓' : 'Copy'}
    </button>
  )
}

export function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="kv">
      <span className="kv-k">{k}</span>
      <span className="kv-v mono">{v}</span>
    </div>
  )
}
