import { api } from './state.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const originalFetch = globalThis.fetch
try {
  const sample = {
    generatedAt: 1,
    platform: 'darwin',
    port: 9091,
    bindHost: '127.0.0.1',
    checks: [
      { id: 'daemon', label: 'Sniffer Daemon', status: 'ok', summary: 'Listening' },
    ],
  }
  let requestUrl = ''
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requestUrl = String(input)
    assert(init === undefined, 'doctor request should not send custom fetch options')
    return Promise.resolve(new Response(JSON.stringify(sample), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
  }) as typeof fetch

  const report = await api.doctor()
  assert(requestUrl === '/api/doctor', `doctor url, got ${requestUrl}`)
  assert(report.port === 9091, `doctor port, got ${report.port}`)
  assert(report.checks[0].id === 'daemon', `doctor check id, got ${report.checks[0].id}`)

  globalThis.fetch = (() => Promise.resolve(new Response('boom', {
    status: 500,
    statusText: 'Server Error',
  }))) as typeof fetch

  let errorMessage = ''
  try {
    await api.doctor()
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : String(e)
  }
  assert(errorMessage.includes('500'), `doctor error should include status, got ${errorMessage}`)
} finally {
  globalThis.fetch = originalFetch
}

console.log('state.test: all assertions passed')
