import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import {
  disconnectStrava,
  getAuthInit,
  getStravaStatus,
  getRateLimitMetrics,
  getWebhookStatus,
  subscribeWebhook,
  unsubscribeWebhook,
} from '../lib/api'

export function StravaConnect() {
  const qc = useQueryClient()
  const status = useQuery({ queryKey: ['strava-status'], queryFn: getStravaStatus, refetchInterval: 15000 })
  const metrics = useQuery({ queryKey: ['ratelimit'], queryFn: getRateLimitMetrics, refetchInterval: 15000 })
  const webhook = useQuery({ queryKey: ['webhook-status'], queryFn: getWebhookStatus, refetchInterval: 15000 })
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
    window.location.href = auth_url
  }

  if (status.isLoading) return <div>Checking Strava status…</div>
  if (status.isError) return <div>Failed to load status</div>

  const connected = status.data?.connected
  const expiresAt = status.data?.expires_at
    ? new Date(status.data.expires_at * 1000).toLocaleString(undefined, { timeZoneName: 'short' })
    : null

  const webhookActive = Boolean(webhook.data?.subscription_id)
  const lastEventDisplay = webhook.data?.last_event_epoch
    ? (webhook.data?.last_event_local || new Date(webhook.data.last_event_epoch * 1000).toLocaleString(undefined, { timeZoneName: 'short' }))
    : 'No events yet'

  return (
    <section className="panel panel--tight">
      <div className="panel-header">
        <div>
          <div className="panel-title">Strava Connection</div>
          <div className="panel-subtitle">
            {connected ? 'Connected' : 'Not connected'}
            {connected && expiresAt ? ` - token expires ${expiresAt}` : ''}
          </div>
        </div>
        <div className="panel-actions">
          {!connected ? (
            <button type="button" className="btn-primary" onClick={connect}>
              Connect to Strava
            </button>
          ) : (
            <button
              type="button"
              onClick={async () => {
                await disconnectStrava()
                qc.invalidateQueries({ queryKey: ['strava-status'] })
              }}
            >
              Disconnect
            </button>
          )}
        </div>
      </div>

      <div className="panel-grid">
        <div className="panel-box">
          <div className="panel-box-title">
            Webhooks <span className={`status-pill ${webhookActive ? 'ok' : 'warn'}`}>{webhookActive ? 'Active' : 'Inactive'}</span>
          </div>
          {webhook.data?.callback_url && (
            <div className="panel-subtitle">
              Callback: <code>{webhook.data.callback_url}</code>
            </div>
          )}
          <div className="panel-subtitle">
            Last event: {lastEventDisplay}
            {webhook.data?.last_activity_id ? ` - Activity ${webhook.data.last_activity_id}` : ''}
            {webhook.data?.last_event_aspect ? ` - ${webhook.data.last_event_aspect}` : ''}
          </div>
          {webhook.data?.last_error && (
            <div className="panel-subtitle" style={{ color: 'var(--danger)' }}>
              Last error: {webhook.data.last_error}
            </div>
          )}
          <div className="panel-actions" style={{ marginTop: 8 }}>
            {webhookActive ? (
              <button
                type="button"
                onClick={async () => {
                  await unsubscribeWebhook()
                  qc.invalidateQueries({ queryKey: ['webhook-status'] })
                }}
              >
                Disable webhooks
              </button>
            ) : (
              <button
                type="button"
                onClick={async () => {
                  await subscribeWebhook()
                  qc.invalidateQueries({ queryKey: ['webhook-status'] })
                }}
              >
                Enable webhooks
              </button>
            )}
            {!webhook.data?.verify_token_set && (
              <span className="panel-subtitle" style={{ color: 'var(--danger)' }}>Missing verify token</span>
            )}
          </div>
        </div>

        <div className="panel-box">
          <div className="panel-box-title">Rate Limits</div>
          {metrics.data ? (
            <div className="stack">
              <div className="panel-subtitle">
                Requests: 15m {metrics.data.requests_15m}, 24h {metrics.data.requests_24h}
              </div>
              {metrics.data.errors_429_15m > 0 && (
                <div className="panel-subtitle">429s (15m): {metrics.data.errors_429_15m}</div>
              )}
              {metrics.data.cooldown_until > 0 && metrics.data.cooldown_until > Math.floor(Date.now() / 1000) && (
                <div className="panel-subtitle">
                  {metrics.data.cooldown_message || `Cooldown until ${new Date(metrics.data.cooldown_until * 1000).toLocaleTimeString()}`}
                </div>
              )}
            </div>
          ) : (
            <div className="panel-subtitle">Metrics loading…</div>
          )}
        </div>
      </div>

      {toast && (
        <div className="toast">
          {toast}
        </div>
      )}
    </section>
  )
}

export default StravaConnect
