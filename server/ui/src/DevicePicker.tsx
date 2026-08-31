import { useEffect, useRef, useState } from 'react'
import type { Device } from './state'

interface DevicePickerProps {
  devices: Device[]
  value: string
  deleting: boolean
  onChange: (deviceId: string) => void
  onDelete: () => Promise<void>
}

export function DevicePicker({ devices, value, deleting, onChange, onDelete }: DevicePickerProps) {
  const [open, setOpen] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = devices.find(device => device.deviceId === value) ?? null
  const connected = devices.filter(device => device.connected)
  const offline = devices.filter(device => !device.connected)

  useEffect(() => {
    if (!open || confirmingDelete) return

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [confirmingDelete, open])

  useEffect(() => {
    if (devices.length === 0) setOpen(false)
  }, [devices.length])

  const selectDevice = (device: Device) => {
    onChange(device.deviceId)
    if (device.connected) setOpen(false)
  }

  const requestDelete = async () => {
    setConfirmingDelete(true)
    try {
      await onDelete()
    } finally {
      setConfirmingDelete(false)
    }
  }

  const renderDevice = (device: Device) => (
    <button
      key={device.deviceId}
      type="button"
      aria-pressed={device.deviceId === value}
      className="device-picker-option"
      onClick={() => selectDevice(device)}
    >
      <span className="device-picker-status" data-connected={device.connected} />
      <span className="device-picker-copy">
        <span className="device-picker-name">{device.deviceName}</span>
        <span className="device-picker-app">{device.appId}</span>
      </span>
      <svg className="device-picker-check" viewBox="0 0 16 16" aria-hidden="true">
        <path d="m3.5 8 3 3 6-6" />
      </svg>
    </button>
  )

  return (
    <div className="device-picker" ref={rootRef}>
      <button
        type="button"
        className="device-picker-trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={devices.length === 0}
        onClick={() => setOpen(current => !current)}
      >
        <span className="device-picker-status" data-connected={selected?.connected ?? false} />
        <span className="device-picker-trigger-copy">
          <span className="device-picker-name">{selected?.deviceName ?? 'No devices'}</span>
          {selected && <span className="device-picker-app">{selected.appId}</span>}
        </span>
        <svg className="device-picker-chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m5 6 3 3 3-3" />
        </svg>
      </button>

      {open && (
        <div className="device-picker-menu" role="dialog" aria-label="Target device">
          <div className="device-picker-header">
            <span>Target device</span>
            <span>{connected.length} online</span>
          </div>
          <div className="device-picker-list">
            {connected.map(renderDevice)}
            {offline.length > 0 && (
              <>
                <div className="device-picker-section">Recent devices</div>
                {offline.map(renderDevice)}
              </>
            )}
          </div>
          {selected && (
            <div className="device-picker-delete-zone">
              <button
                type="button"
                className="device-picker-delete"
                disabled={deleting || confirmingDelete}
                onClick={() => void requestDelete()}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3 4.5h10M6 4.5v-2h4v2m-5.5 0 .6 9h5.8l.6-9M6.8 7v4m2.4-4v4" />
                </svg>
                <span>
                  <span>{deleting ? 'Deleting…' : `Delete ${selected.connected ? 'connected' : 'offline'} device`}</span>
                  <small>{selected.deviceName} · {selected.appId}</small>
                </span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
