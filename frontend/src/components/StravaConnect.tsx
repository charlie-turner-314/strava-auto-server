import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { disconnectStrava, getAuthInit, getStravaStatus, getRateLimitMetrics } from '../lib/api'

export function StravaConnect() {
  const qc = useQueryClient()
  const status = useQuery({ queryKey: ['strava-status'], queryFn: getStravaStatus, refetchInterval: 15000 })
  const metrics = useQuery({ queryKey: ['ratelimit'], queryFn: getRateLimitMetrics, refetchInterval: 15000 })
  const [toast, setToast] = useState<string | null>(null)
  function showToast(msg: string) {
    setToast(msg)
    window.setTimeout(() => setToast(null), 3000)
  }
  const lastCooldownRef = useRef<number>(0)
  useEffect(() => {
    const m = metrics.data
    if (!m) return
    const now = Math.floor(Date.now() / 1000)
    if (m.cooldown_until > now && m.cooldown_until !== lastCooldownRef.current) {
      lastCooldownRef.current = m.cooldown_until
      showToast(m.cooldown_message || `Strava cooldown active until ${new Date(m.cooldown_until * 1000).toLocaleTimeString()}`)
    }
  }, [metrics.data])

  async function connect() {
    const { auth_url } = await getAuthInit()
    // Redirect to Strava OAuth
    window.location.href = auth_url
  }

  if (status.isLoading) return <div>Checking Strava status…</div>
  if (status.isError) return <div>Failed to load status</div>

  const connected = status.data?.connected
  const expiresAt = status.data?.expires_at
    ? new Date(status.data.expires_at * 1000).toLocaleString(undefined, { timeZoneName: 'short' })
    : null

  return (
    <div style={{ padding: '0.5rem', border: '1px solid var(--border)', borderRadius: 8, marginBottom: '1rem' }}>
      <strong>Strava</strong>: {connected ? 'Connected' : 'Not connected'}
      {connected && expiresAt ? <span> (token expires {expiresAt})</span> : null}
      {!connected && (
        <button onClick={connect} style={{ marginLeft: 12 }}>Connect to Strava</button>
      )}
      {connected && (
        <button
          onClick={async () => { await disconnectStrava(); qc.invalidateQueries({ queryKey: ['strava-status'] }) }}
          style={{ marginLeft: 12 }}
        >Disconnect</button>
      )}
      {metrics.data && (
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
          Requests: 15m {metrics.data.requests_15m}, 24h {metrics.data.requests_24h}
          {metrics.data.errors_429_15m > 0 && <span> • 429s (15m): {metrics.data.errors_429_15m}</span>}
          {metrics.data.cooldown_until > 0 && metrics.data.cooldown_until > Math.floor(Date.now()/1000) && (
            <span> • {metrics.data.cooldown_message || `Cooldown until ${new Date(metrics.data.cooldown_until * 1000).toLocaleTimeString()}`}</span>
          )}
        </div>
      )}
      {toast && (
        <div style={{ position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)', background: 'var(--notice-bg, #333)', color: 'var(--notice-fg, #fff)', padding: '8px 12px', borderRadius: 8, boxShadow: '0 2px 10px rgba(0,0,0,0.2)' }}>
          {toast}
        </div>
      )}
    </div>
  )
}

export default StravaConnect
