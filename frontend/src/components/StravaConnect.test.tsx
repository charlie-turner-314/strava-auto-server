import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { buildPollingChartData, usePollingChartData, formatSeconds, minuteToLabel } from './StravaConnect'
import type { PollingProfile } from '../lib/api'

describe('usePollingChartData / buildPollingChartData', () => {
  const baseProfile: PollingProfile = {
    intervals: Array.from({ length: 1440 }, () => 300),
    fallback: 300,
    total_samples: 10,
    computed_at: undefined,
    valid_until: undefined,
  }

  it('returns null when no profile data', () => {
    const { result } = renderHook(() => usePollingChartData(undefined, 0))
    expect(result.current).toBeNull()
  })

  it('builds chart data and ensures now minute is present', () => {
    const profile = { ...baseProfile }
    profile.intervals[75] = 60
    profile.intervals[600] = 120

    const { result } = renderHook(() => usePollingChartData(profile, 600))
    expect(result.current).not.toBeNull()
    const chart = result.current!
    expect(chart.data.length).toBeGreaterThan(0)
    expect(chart.data.length).toBeLessThanOrEqual(289)
    expect(chart.data.some((pt) => pt.minute === 600)).toBe(true)
    expect(chart.xTickInterval).toBeGreaterThan(0)
  })

  it('uses fallback when intervals are invalid', () => {
    const profile: PollingProfile = {
      intervals: Array.from({ length: 1440 }, (_, i) => (i % 2 === 0 ? 'bad' : 90) as any),
      fallback: 90,
      total_samples: 5,
      computed_at: undefined,
      valid_until: undefined,
    }
    const chart = buildPollingChartData(profile, 120)
    expect(chart).not.toBeNull()
    expect(chart!.data.some((pt) => pt.minute === 120)).toBe(true)
  })
})

describe('formatSeconds', () => {
  it('formats seconds and minutes gracefully', () => {
    expect(formatSeconds(45)).toBe('45s')
    expect(formatSeconds(120)).toBe('2 min')
    expect(formatSeconds(135)).toBe('2.3 min')
    expect(formatSeconds(Number.NaN)).toBe('NaNs')
  })
})

describe('minuteToLabel', () => {
  it('wraps past 24h and pads zeros', () => {
    expect(minuteToLabel(0)).toBe('00:00')
    expect(minuteToLabel(61)).toBe('01:01')
    expect(minuteToLabel(1500)).toBe('01:00')
    expect(minuteToLabel(-5)).toBe('00:00')
  })
})
