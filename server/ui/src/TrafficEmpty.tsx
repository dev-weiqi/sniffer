import type { Device } from './state'

export interface TrafficEmptyProps {
  device: Device | null
  serverConnected: boolean
  hasTraffic: boolean
  onResetFilters: () => void
  onOpenSettings: () => void
}

export function TrafficEmpty({ kind, device, serverConnected, hasTraffic, onResetFilters, onOpenSettings }: TrafficEmptyProps & { kind: 'http' | 'socket' }) {
  // Existing records are hidden by filters even if their device has since disconnected.
  const title = hasTraffic ? 'No matching results'
    : !serverConnected ? 'Monitor disconnected'
    : !device ? 'No device connected'
    : !device.connected ? 'Device is offline'
    : kind === 'http' ? 'Waiting for requests' : 'Waiting for socket events'
  const hint = hasTraffic ? 'Clear the search and filters to show captured traffic.'
    : !serverConnected ? 'Sniffer is reconnecting. Make sure the local monitor is running.'
    : !device ? 'Open your debug app on a connected device to start capturing traffic.'
    : !device.connected ? `Reopen ${device.appId} on ${device.deviceName} and check the device connection.`
    : kind === 'http' ? 'Use the app to make a request. It will appear here automatically.'
    : 'Use the app to send or receive a Socket.IO or WebSocket message.'
  return (
    <div className="empty traffic-empty" role="status">
      <strong>{title}</strong>
      <p>{hint}</p>
      {hasTraffic
        ? <button onClick={onResetFilters}>Clear filters</button>
        : <button className="ghost" onClick={onOpenSettings}>Connection settings</button>}
    </div>
  )
}
