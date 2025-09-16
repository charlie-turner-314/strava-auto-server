import { describe, it, expect } from 'vitest'
import { evaluateConditions, previewEffects } from './eval'

const baseActivity = {
  id: 1,
  start_date: '2024-01-01T00:00:00Z',
  start_date_local: '2024-01-01T11:00:00+11:00',
  sport_type: 'Run',
  name: 'Morning Run',
  distance: 5000,
  moving_time: 1800,
  elapsed_time: 1900,
  total_elevation_gain: 120,
}

describe('evaluateConditions', () => {
  it('handles sport type equals', () => {
    const ok = evaluateConditions([{ type: 'sport_type', op: 'equals', value: 'Run' } as any], baseActivity as any)
    const no = evaluateConditions([{ type: 'sport_type', op: 'equals', value: 'Ride' } as any], baseActivity as any)
    expect(ok).toBe(true)
    expect(no).toBe(false)
  })

  it('handles numeric comparisons', () => {
    expect(evaluateConditions([{ type: 'distance', op: 'gt', value: 4000 } as any], baseActivity as any)).toBe(true)
    expect(evaluateConditions([{ type: 'moving_time', op: 'gt', value: 2000 } as any], baseActivity as any)).toBe(false)
    expect(evaluateConditions([{ type: 'total_elevation_gain', op: 'gt', value: 100 } as any], baseActivity as any)).toBe(true)
  })

  it('handles title contains', () => {
    expect(evaluateConditions([{ type: 'title', op: 'contains', value: 'morning' } as any], baseActivity as any)).toBe(true)
    expect(evaluateConditions([{ type: 'title', op: 'contains', value: 'evening' } as any], baseActivity as any)).toBe(false)
  })
})

describe('previewEffects', () => {
  it('builds name with prefix/suffix and toggles commute', () => {
    const p = previewEffects(
      [
        { type: 'set_title_prefix', params: { prefix: '[Run] ' } } as any,
        { type: 'set_title_suffix', params: { suffix: ' 🚀' } } as any,
        { type: 'set_commute', params: { commute: true } } as any,
        { type: 'set_sport_type', params: { sport_type: 'Ride' } } as any,
      ],
      baseActivity as any,
    )
    expect(p.name).toBe('[Run] Morning Run 🚀')
    expect(p.commute).toBe(true)
    expect(p.sport_type).toBe('Ride')
  })
})

