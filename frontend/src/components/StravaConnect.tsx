import { useEffect, useMemo, useState, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
} from 'recharts'

import {
  disconnectStrava,
  getAuthInit,
  getStravaStatus,
  getRateLimitMetrics,
  getPollingProfile,
  type PollingProfile,
} from '../lib/api'

export function StravaConnect() {
  const qc = useQueryClient()
  const status = useQuery({ queryKey: ['strava-status'], queryFn: getStravaStatus, refetchInterval: 15000 })
  const metrics = useQuery({ queryKey: ['ratelimit'], queryFn: getRateLimitMetrics, refetchInterval: 15000 })
  const profile = useQuery({ queryKey: ['polling-profile'], queryFn: getPollingProfile, refetchInterval: 60000 })
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

  const nowMinute = useMemo(() => {
    const now = new Date()
    return now.getHours() * 60 + now.getMinutes()
  }, [])

  const chartData = usePollingChartData(profile.data, nowMinute)

  if (status.isLoading) return <div>Checking Strava status…</div>
  if (status.isError) return <div>Failed to load status</div>

  const connected = status.data?.connected
  const expiresAt = status.data?.expires_at
    ? new Date(status.data.expires_at * 1000).toLocaleString(undefined, { timeZoneName: 'short' })
    : null

  const nextSyncDisplay = metrics.data && metrics.data.next_sync_epoch > 0
    ? (metrics.data.next_sync_local || new Date(metrics.data.next_sync_epoch * 1000).toLocaleString(undefined, { timeZoneName: 'short' }))
    : 'Scheduling…'
  const intervalSeconds = metrics.data?.current_interval_sec ?? 0
  const cadenceLabel = intervalSeconds > 0
    ? intervalSeconds >= 60
      ? `${(intervalSeconds / 60).toFixed(intervalSeconds % 60 === 0 ? 0 : 1)} min`
      : `${intervalSeconds}s`
    : null

  return (
    <div style={{ padding: '0.5rem', border: '1px solid var(--border)', borderRadius: 8, marginBottom: '1rem' }}>
      <strong>Strava</strong>: {connected ? 'Connected' : 'Not connected'}
      {connected && expiresAt ? <span> (token expires {expiresAt})</span> : null}
      {!connected && (
        <button onClick={connect} style={{ marginLeft: 12 }}>
          Connect to Strava
        </button>
      )}
      {connected && (
        <button
          onClick={async () => {
            await disconnectStrava()
            qc.invalidateQueries({ queryKey: ['strava-status'] })
          }}
          style={{ marginLeft: 12 }}
        >
          Disconnect
        </button>
      )}
      {metrics.data && (
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
          Requests: 15m {metrics.data.requests_15m}, 24h {metrics.data.requests_24h}
          {metrics.data.errors_429_15m > 0 && <span> • 429s (15m): {metrics.data.errors_429_15m}</span>}
          {metrics.data.cooldown_until > 0 && metrics.data.cooldown_until > Math.floor(Date.now() / 1000) && (
            <span> • {metrics.data.cooldown_message || `Cooldown until ${new Date(metrics.data.cooldown_until * 1000).toLocaleTimeString()}`}</span>
          )}
        </div>
      )}
      {metrics.data && (
        <div style={{ marginTop: 2, fontSize: 12, color: 'var(--muted)' }}>
          Next Strava sync: {nextSyncDisplay}
          {cadenceLabel && <span> • cadence ~ {cadenceLabel}</span>}
        </div>
      )}
      {profile.isError && <div style={{ marginTop: 8, fontSize: 12, color: 'crimson' }}>Failed to load polling profile</div>}
      {chartData && chartData.data.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>24h polling cadence (seconds between runs)</div>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={chartData.data} margin={{ top: 10, right: 20, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                dataKey="minute"
                minTickGap={40}
                tickFormatter={(value) => minuteToLabel(Number(value))}
                interval={chartData.xTickInterval}
              />
              <YAxis
                dataKey="interval"
                tickFormatter={(value) => formatSeconds(Number(value))}
                width={70}
                domain={['dataMin', 'dataMax']}
                allowDecimals={false}
              />
              <Tooltip
                formatter={(value: number) => formatSeconds(Number(value))}
                labelFormatter={(minute: number) => `Time ${minuteToLabel(minute)}`}
              />
              <Line
                type="monotone"
                dataKey="interval"
                stroke="var(--accent, #0b5cab)"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
              <ReferenceLine x={nowMinute} stroke="var(--muted, #888)" strokeDasharray="4 4" />
            </LineChart>
          </ResponsiveContainer>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
            Min {formatSeconds(chartData.minInterval)} • Max {formatSeconds(chartData.maxInterval)} • Points {chartData.data.length}
            {profile.data?.total_samples ? ` • Activity samples ${profile.data.total_samples}` : ''}
          </div>
        </div>
      )}
      {toast && (
        <div
          style={{
            position: 'fixed',
            bottom: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--notice-bg, #333)',
            color: 'var(--notice-fg, #fff)',
            padding: '8px 12px',
            borderRadius: 8,
            boxShadow: '0 2px 10px rgba(0,0,0,0.2)',
          }}
        >
          {toast}
        </div>
      )}
    </div>
  )
}

export default StravaConnect

// eslint-disable-next-line react-refresh/only-export-components
export function usePollingChartData(profile: PollingProfile | undefined, nowMinute: number): PollingChartData | null {
  return useMemo(() => buildPollingChartData(profile, nowMinute), [profile, nowMinute])
}

export type PollingChartData = {
  data: { minute: number; interval: number }[]
  minInterval: number
  maxInterval: number
  xTickInterval: number
}

// eslint-disable-next-line react-refresh/only-export-components
export function buildPollingChartData(profile: PollingProfile | undefined, nowMinute: number): PollingChartData | null {
  if (!profile || !Array.isArray(profile.intervals) || profile.intervals.length === 0) {
    return null
  }
  const allPoints = profile.intervals
    .map((value, minute) => ({ minute, interval: Number(value) }))
    .filter((pt) => Number.isFinite(pt.interval) && pt.interval > 0)
  if (allPoints.length === 0) return null

  const targetPoints = 288 // roughly every 5 minutes
  const step = Math.max(1, Math.floor(allPoints.length / targetPoints))
  const reduced: { minute: number; interval: number }[] = []
  for (let i = 0; i < allPoints.length; i += step) {
    reduced.push(allPoints[i])
  }
  if (!reduced.length) reduced.push(allPoints[0])

  if (!reduced.some((pt) => pt.minute === nowMinute)) {
    const candidate = allPoints[nowMinute]?.interval
    const fallbackValue = (typeof candidate === 'number' && Number.isFinite(candidate))
      ? candidate
      : (Number(profile.fallback) || reduced[0].interval)
    reduced.push({ minute: nowMinute, interval: fallbackValue })
  }
  reduced.sort((a, b) => a.minute - b.minute)

  const minInterval = reduced.reduce((acc, cur) => Math.min(acc, cur.interval), reduced[0].interval)
  const maxInterval = reduced.reduce((acc, cur) => Math.max(acc, cur.interval), reduced[0].interval)
  const xTickInterval = Math.max(1, Math.floor(reduced.length / 8))

  return {
    data: reduced,
    minInterval,
    maxInterval,
    xTickInterval,
  }
}

// eslint-disable-next-line react-refresh/only-export-components
export function formatSeconds(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return `${Math.round(sec)}s`
  if (sec < 120) return `${Math.round(sec)}s`
  const minutes = sec / 60
  return minutes % 1 === 0 ? `${minutes} min` : `${minutes.toFixed(1)} min`
}

// eslint-disable-next-line react-refresh/only-export-components
export function minuteToLabel(minute: number): string {
  const m = Math.max(0, minute) % 1440
  const h = Math.floor(m / 60)
  const mm = m % 60
  return `${h.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}`
}
