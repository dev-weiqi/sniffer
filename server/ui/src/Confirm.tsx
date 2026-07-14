import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

type Ask = (message: string, action?: string) => Promise<boolean>

const ConfirmCtx = createContext<Ask>(() => Promise.resolve(false))

/** themed replacement for window.confirm: `if (await confirm('Delete?', 'Delete')) …` */
export const useConfirm = () => useContext(ConfirmCtx)

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<{ message: string; action: string; resolve: (v: boolean) => void } | null>(null)

  const ask = useCallback<Ask>((message, action = 'Confirm') =>
    new Promise(resolve => setReq({ message, action, resolve })), [])

  const answer = (v: boolean) => {
    req?.resolve(v)
    setReq(null)
  }

  useEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); answer(false) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {req && (
        <div className="modal-backdrop" onMouseDown={() => answer(false)}>
          <div className="modal" role="alertdialog" onMouseDown={e => e.stopPropagation()}>
            <p>{req.message}</p>
            <div className="modal-actions">
              <button className="ghost" onClick={() => answer(false)}>Cancel</button>
              <button className="modal-danger" autoFocus onClick={() => answer(true)}>{req.action}</button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  )
}
