import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ShoeStats } from './ShoeStats'

const API_BASE = 'http://localhost:8000'

const sample = [
  {
    gear_id: 'shoe-1',
    name: 'Tempo Next',
    is_primary: true,
    lifetime_distance: 90000,
    activity_count: 3,
    total_distance: 30000,
    total_moving_time: 9000,
    avg_cadence: 86.5,
    avg_pace_s_per_km: 310,
    first_activity_at: '2024-01-01T10:00:00Z',
    last_activity_at: '2024-01-10T10:00:00Z',
  },
  {
    gear_id: 'shoe-2',
    name: 'Daily Trainer',
    is_primary: false,
    lifetime_distance: 12000,
    activity_count: 2,
    total_distance: 15000,
    total_moving_time: 4800,
    avg_cadence: 82.0,
    avg_pace_s_per_km: 345,
    first_activity_at: '2024-02-01T10:00:00Z',
    last_activity_at: '2024-02-08T10:00:00Z',
  },
]

const server = setupServer(
  http.get(`${API_BASE}/api/gear/shoes`, () => {
    return HttpResponse.json({ items: sample })
  }),
)

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

it('shows shoe stats and supports sorting', async () => {
  renderWithClient(<ShoeStats />)

  const tempo = await screen.findByText('Tempo Next')
  expect(tempo).toBeTruthy()

  const rows = () => screen.getAllByRole('row').slice(1) // skip header
  expect(within(rows()[0]).getByText('Tempo Next')).toBeTruthy()

  await userEvent.click(screen.getByRole('button', { name: 'Shoe' }))
  expect(within(rows()[0]).getByText('Daily Trainer')).toBeTruthy()

  await userEvent.click(screen.getByRole('button', { name: 'Shoe ^' }))
  expect(within(rows()[0]).getByText('Tempo Next')).toBeTruthy()

  await userEvent.click(screen.getByRole('button', { name: 'Avg Pace' }))
  // Desc sort: slower pace (bigger number) first, should be Daily Trainer
  expect(within(rows()[0]).getByText('Daily Trainer')).toBeTruthy()
})
