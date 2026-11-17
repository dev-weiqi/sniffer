export interface FieldReplacement { path: string; value: unknown }

/** Replace existing JSON Pointer targets only; validate the whole edit before any caller saves it. */
export function replaceJsonFields(body: unknown, replacements: unknown) {
  if (typeof body !== 'string') throw new Error('Response body must be JSON text')
  let root: unknown
  try { root = JSON.parse(body) } catch { throw new Error('Response body is not valid JSON') }
  if (!Array.isArray(replacements) || replacements.length < 1 || replacements.length > 100)
    throw new Error('Provide between 1 and 100 field replacements')
  const safeNumbers = (value: unknown): void => {
    if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))))
      throw new Error('JSON contains a number that cannot be safely edited')
    if (value && typeof value === 'object') Object.values(value).forEach(safeNumbers)
  }
  safeNumbers(root)
  const kind = (v: unknown) => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v
  const changes: Array<{ path: string; before: unknown; after: unknown }> = []
  const paths: string[][] = []
  for (const replacement of replacements) {
    if (!replacement || typeof replacement !== 'object' || Array.isArray(replacement) ||
      typeof replacement.path !== 'string' || !Object.hasOwn(replacement, 'value') ||
      Object.keys(replacement).some(k => k !== 'path' && k !== 'value')) throw new Error('Each replacement needs path and value')
    const { path, value } = replacement as FieldReplacement
    if (!path.startsWith('/') || /~(?![01])/.test(path)) throw new Error('Use a JSON Pointer such as /data/commentCount')
    const parts = path.slice(1).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'))
    if (parts.some(p => ['__proto__', 'prototype', 'constructor'].includes(p))) throw new Error('Reserved field path')
    if (paths.some(previous => previous.slice(0, Math.min(previous.length, parts.length)).every((p, i) => p === parts[i])))
      throw new Error('Duplicate or overlapping field paths')
    paths.push(parts)
    let parent = root
    for (const part of parts.slice(0, -1)) parent = child(parent, part)
    const key = parts.at(-1)!
    const before = child(parent, key)
    if (kind(before) !== kind(value)) throw new Error(`Replacement must keep the existing ${kind(before)} type`)
    safeNumbers(value)
    ;(parent as Record<string, unknown>)[key] = value
    changes.push({ path, before, after: value })
  }
  return { body: JSON.stringify(root, null, 2), changes }
}

function child(parent: unknown, key: string): unknown {
  if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key) ||
    (Array.isArray(parent) && !/^(0|[1-9][0-9]*)$/.test(key))) throw new Error('Field does not exist in the response body')
  return (parent as Record<string, unknown>)[key]
}
