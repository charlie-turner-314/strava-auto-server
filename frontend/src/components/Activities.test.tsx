import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Activities } from './Activities'
import type { Activity } from '../lib/api'

const API = 'http://localhost:8000'

function makeItems(offset: number, limit: number): Activity[] {
  const items: Activity[] = []
  for (let i = 0; i < limit; i++) {
    const id = offset + i + 1
    items.push({
      id,
      start_date: '2024-01-01T10:00:00Z',
      start_date_local: '2024-01-01T21:00:00+11:00',
      sport_type: id % 2 ? 'Run' : 'Ride',
      name: `Activity ${id}`,
      distance: 1234 * id,
      moving_time: 60 * id,
      elapsed_time: 60 * id,
      total_elevation_gain: 10 * id,
    })
  }
  return items
}

const server = setupServer(
  http.get(`${API}/api/activities`, ({ request }) => {
    const url = new URL(request.url)
    const limit = Number(url.searchParams.get('limit') || '10')
    const offset = Number(url.searchParams.get('offset') || '0')
    const total = 15
    const page = makeItems(offset, Math.min(limit, Math.max(0, total - offset)))
    return HttpResponse.json({ total, items: page })
  }),
)

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

it('paginates activities and formats values', async () => {
  renderWithClient(<Activities />)
  // First page shows Activity 1..10
  expect(await screen.findByText('Activity 1')).toBeTruthy()
  expect(screen.getByText('Activity 10')).toBeTruthy()
  // Distances formatted in km
  expect(screen.getAllByText(/km$/)[0].textContent).toMatch(/\d+\.\d{2}km/)

  // Next page
  await userEvent.click(screen.getByRole('button', { name: /Next/i }))
  expect(await screen.findByText('Activity 11')).toBeTruthy()
  // Prev page back to 1
  await userEvent.click(screen.getByRole('button', { name: /Prev/i }))
  expect(await screen.findByText('Activity 1')).toBeTruthy()
})
