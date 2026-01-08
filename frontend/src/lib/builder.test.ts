import { describe, it, expect } from 'vitest'
import { conditionFromSelection, effectFromSelection } from './builder'

describe('builder mapping', () => {
  it('maps sport_type equals', () => {
    const c = conditionFromSelection('sport_type', 'Run')
    expect(c).toEqual({ type: 'sport_type', op: 'equals', value: 'Run' })
  })
  it('maps distance greater than', () => {
    const c = conditionFromSelection('distance_greater_than', '5000')
    expect(c).toEqual({ type: 'distance', op: 'gt', value: 5000 })
  })
  it('maps moving_time greater than', () => {
    const c = conditionFromSelection('moving_time_greater_than', '1800')
    expect(c).toEqual({ type: 'moving_time', op: 'gt', value: 1800 })
  })
  it('maps elevation gain greater than', () => {
    const c = conditionFromSelection('elevation_gain_greater_than', '300')
    expect(c).toEqual({ type: 'total_elevation_gain', op: 'gt', value: 300 })
  })
  it('maps title contains', () => {
    const c = conditionFromSelection('title_contains', 'Commute')
    expect(c).toEqual({ type: 'title', op: 'contains', value: 'Commute' })
  })
  it('maps set_title_suffix', () => {
    const e = effectFromSelection('set_title_suffix', ' 🚀')
    expect(e).toEqual({ type: 'set_title_suffix', params: { suffix: ' 🚀' } })
  })
  it('maps set_title_prefix', () => {
    const e = effectFromSelection('set_title_prefix', '[Ride] ')
    expect(e).toEqual({ type: 'set_title_prefix', params: { prefix: '[Ride] ' } })
  })
  it('maps set_commute', () => {
    const e = effectFromSelection('set_commute', '')
    expect(e).toEqual({ type: 'set_commute', params: { commute: true } })
  })
  it('maps set_sport_type', () => {
    const e = effectFromSelection('set_sport_type', 'Ride')
    expect(e).toEqual({ type: 'set_sport_type', params: { sport_type: 'Ride' } })
  })
  it('maps hide_from_feeds', () => {
    const e = effectFromSelection('hide_from_feeds', '')
    expect(e).toEqual({ type: 'hide_from_feeds', params: { home: true } })
  })
})
