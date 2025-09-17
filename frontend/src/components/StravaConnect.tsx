import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { disconnectStrava, getAuthInit, getStravaStatus, getRateLimitMetrics, getPollingProfile, type PollingProfile } from '../lib/api'

export function StravaConnect() {
  const qc = useQueryClient()
  const status = useQuery({ queryKey: ['strava-status'], queryFn: getStravaStatus, refetchInterval: 15000 })
  const metrics = useQuery({ queryKey: ['ratelimit'], queryFn: getRateLimitMetrics, refetchInterval: 15000 })
  const profile = useQuery({ queryKey: ['polling-profile'], queryFn: getPollingProfile, refetchInterval: 60000 })
  const [toast, setToast] = useState<string | null>(null)
  const chartRef = useRef<HTMLDivElement | null>(null)
  const [chartWidth, setChartWidth] = useState<number>(300)
  const [hover, setHover] = useState<(SparklinePoint & { cssX: number; cssY: number; containerWidth: number; containerHeight: number }) | null>(null)
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

  useEffect(() => {
    const el = chartRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect?.width ?? el.clientWidth
        if (width) {
          setChartWidth((prev) => (width !== prev ? width : prev))
        }
      }
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  async function connect() {
    const { auth_url } = await getAuthInit()
    // Redirect to Strava OAuth
    window.location.href = auth_url
  }

  const sparkline = useSparkline(profile.data, chartWidth)

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
    ? (intervalSeconds >= 60
        ? `${(intervalSeconds / 60).toFixed(intervalSeconds % 60 === 0 ? 0 : 1)} min`
        : `${intervalSeconds}s`)
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
      {metrics.data && (
        <div style={{ marginTop: 2, fontSize: 12, color: 'var(--muted)' }}>
          Next Strava sync: {nextSyncDisplay}
          {cadenceLabel && <span> • cadence ~ {cadenceLabel}</span>}
        </div>
      )}
      {profile.isError && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'crimson' }}>Failed to load polling profile</div>
      )}
      {profile.data && sparkline && (
        <div style={{ marginTop: 10, position: 'relative' }} ref={chartRef}>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>
            24h polling cadence (seconds between runs)
          </div>
          <svg
            width={sparkline.width}
            height={sparkline.height}
            viewBox={`0 0 ${sparkline.width} ${sparkline.height}`}
            style={{ display: 'block', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, width: '100%' }}
            preserveAspectRatio="none"
            onMouseMove={(e) => {
              const svg = e.currentTarget as SVGSVGElement
              const rect = svg.getBoundingClientRect()
              const x = e.clientX - rect.left
              const svgX = (x / rect.width) * sparkline.width
              const nearest = findNearestPoint(sparkline.points, svgX)
              setHover(
                nearest
                  ? {
                      ...nearest,
                      cssX: (nearest.x / sparkline.width) * rect.width,
                      cssY: (nearest.y / sparkline.height) * rect.height,
                      containerWidth: rect.width,
                      containerHeight: rect.height,
                    }
                  : null,
              )
            }}
            onMouseLeave={() => setHover(null)}
          >
            <path d={sparkline.path} fill="none" stroke="var(--accent, #0b5cab)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            {hover && (
              <g>
                <line x1={hover.x} x2={hover.x} y1={0} y2={sparkline.height} stroke="var(--accent, #0b5cab)" strokeDasharray="4 3" strokeWidth={1} />
              </g>
            )}
          </svg>
          {hover && (
            <div
              style={{
                position: 'absolute',
                left: `${hover.cssX - 5}px`,
                top: `${hover.cssY - 5}px`,
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: 'var(--accent, #0b5cab)',
                border: '2px solid #fff',
                pointerEvents: 'none',
                boxShadow: '0 1px 4px rgba(0,0,0,0.3)'
              }}
            />
          )}
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
            Min {formatSeconds(sparkline.min)} • Max {formatSeconds(sparkline.max)} • Points {sparkline.samples}
            {profile.data.total_samples ? ` • Activity samples ${profile.data.total_samples}` : ''}
          </div>
          {hover && (
            <div
              style={{
                position: 'relative',
                height: 0,
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  top: `${Math.max(hover.cssY - 50, 0)}px`,
                  left: `${Math.min(Math.max(hover.cssX - 60, 0), hover.containerWidth - 120)}px`,
                  background: 'var(--tooltip-bg, rgba(0,0,0,0.8))',
                  color: 'var(--tooltip-fg, #fff)',
                  padding: '4px 8px',
                  borderRadius: 4,
                  fontSize: 11,
                  pointerEvents: 'none',
                  boxShadow: '0 2px 6px rgba(0,0,0,0.25)',
                }}
              >
                <div>Time {minuteToLabel(hover.minute)}</div>
                <div>Cadence {formatSeconds(hover.value)}</div>
              </div>
            </div>
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

export type SparklinePoint = {
  x: number
  y: number
  value: number
  minute: number
}

type SparklineResult = {
  path: string
  width: number
  height: number
  min: number
  max: number
  samples: number
  points: SparklinePoint[]
}

export function useSparkline(profile: PollingProfile | undefined, width: number): SparklineResult | null {
  return useMemo(() => {
    if (!profile || !Array.isArray(profile.intervals) || profile.intervals.length === 0) {
      return null
    }
    const cleaned = profile.intervals
      .map((n, idx) => ({ value: Number(n), minute: idx }))
      .filter((p) => Number.isFinite(p.value) && p.value > 0)
    if (cleaned.length === 0) return null
    const targetPoints = 240
    const step = Math.max(1, Math.floor(cleaned.length / targetPoints))
    const samples: { value: number; minute: number }[] = []
    for (let i = 0; i < cleaned.length; i += step) {
      samples.push(cleaned[i])
    }
    if (samples.length === 1) samples.push(samples[0])
    const min = Math.min(...samples.map((s) => s.value))
    const max = Math.max(...samples.map((s) => s.value))
    const range = max - min || 1
    const svgWidth = Math.max(width || 0, 260)
    const height = 60
    const points: SparklinePoint[] = samples.map((sample, idx) => {
      const x = samples.length === 1 ? svgWidth / 2 : (idx / (samples.length - 1)) * (svgWidth - 2) + 1
      const norm = (sample.value - min) / range
      const y = height - 1 - norm * (height - 2)
      return { x, y, value: sample.value, minute: sample.minute }
    })
    const path = points
      .map((pt, idx) => `${idx === 0 ? 'M' : 'L'}${pt.x.toFixed(2)},${pt.y.toFixed(2)}`)
      .join(' ')
    return { path, width: svgWidth, height, min, max, samples: points.length, points }
  }, [profile, width])
}

export function findNearestPoint(points: SparklinePoint[], svgX: number): SparklinePoint | null {
  if (!points.length) return null
  let best = points[0]
  let bestDist = Math.abs(points[0].x - svgX)
  for (let i = 1; i < points.length; i += 1) {
    const dist = Math.abs(points[i].x - svgX)
    if (dist < bestDist) {
      best = points[i]
      bestDist = dist
    }
  }
  return best
}

export function formatSeconds(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return `${Math.round(sec)}s`
  if (sec < 120) return `${Math.round(sec)}s`
  const minutes = sec / 60
  return minutes % 1 === 0 ? `${minutes} min` : `${minutes.toFixed(1)} min`
}

export function minuteToLabel(minute: number): string {
  const m = Math.max(0, minute) % 1440
  const h = Math.floor(m / 60)
  const mm = m % 60
  return `${h.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}`
}
