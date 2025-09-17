import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useSparkline, formatSeconds, minuteToLabel, findNearestPoint, type SparklinePoint } from './StravaConnect'
import type { PollingProfile } from '../lib/api'

describe('useSparkline', () => {
  it('returns null when no profile data', () => {
    const { result } = renderHook(() => useSparkline(undefined, 400))
    expect(result.current).toBeNull()
  })

  it('builds scaled points and respects width', () => {
    const profile: PollingProfile = {
      intervals: Array.from({ length: 1440 }, () => 300),
      fallback: 300,
      total_samples: 10,
      computed_at: undefined,
      valid_until: undefined,
    }
    profile.intervals[75] = 60
    profile.intervals[600] = 120

    const { result } = renderHook(() => useSparkline(profile, 500))
    expect(result.current).not.toBeNull()
    const spark = result.current!
    expect(spark.width).toBeGreaterThanOrEqual(500)
    expect(spark.height).toBeGreaterThan(0)
    expect(spark.points.length).toBeGreaterThan(0)
    expect(spark.points.length).toBeLessThanOrEqual(241)
    expect(spark.points.some((p) => Math.abs(p.minute - 75) <= 6)).toBe(true)
  })

  it('falls back to minimum width when width is tiny', () => {
    const profile: PollingProfile = {
      intervals: Array.from({ length: 1440 }, () => 90),
      fallback: 90,
      total_samples: 5,
      computed_at: undefined,
      valid_until: undefined,
    }
    const { result } = renderHook(() => useSparkline(profile, 0))
    expect(result.current).not.toBeNull()
    expect(result.current!.width).toBeGreaterThanOrEqual(260)
  })
})

describe('findNearestPoint', () => {
  const points: SparklinePoint[] = [
    { x: 0, y: 10, value: 100, minute: 0 },
    { x: 50, y: 20, value: 90, minute: 60 },
    { x: 100, y: 30, value: 80, minute: 120 },
  ]

  it('returns the closest point along X', () => {
    expect(findNearestPoint(points, 55)?.minute).toBe(60)
    expect(findNearestPoint(points, 10)?.minute).toBe(0)
    expect(findNearestPoint(points, 95)?.minute).toBe(120)
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
