export function parsePortInput(value: string): number | null {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const port = Number(trimmed)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null
  return port
}
