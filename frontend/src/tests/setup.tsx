import { vi } from 'vitest'
import React from 'react'

vi.mock('recharts', () => {
  const ResponsiveContainer = ({ children, width, height }: any) => (
    <div data-testid="responsive-container" style={{ width: width || '100%', height: typeof height === 'number' ? `${height}px` : height }}>{children}</div>
  )
  const SimpleWrapper = ({ children }: any) => <div>{children}</div>
  const Line = () => null
  const CartesianGrid = () => null
  const ReferenceLine = () => null
  const Tooltip = () => null
  const XAxis = () => null
  const YAxis = () => null
  return {
    ResponsiveContainer,
    LineChart: SimpleWrapper,
    Line,
    XAxis,
    YAxis,
    Tooltip,
    CartesianGrid,
    ReferenceLine,
  }
})
