import { render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StravaConnect } from './StravaConnect'

const API = 'http://localhost:8000'

const server = setupServer(
  http.get(`${API}/api/auth/strava/status`, () => {
    return HttpResponse.json({ connected: true, expires_at: 1710000000, scope: 'read' })
  }),
  http.get(`${API}/api/admin/ratelimit`, () => {
    return HttpResponse.json({
      now: 1710000000,
      cooldown_until: 0,
      cooldown_until_local: '',
      cooldown_reason: '',
      cooldown_scope: '',
      cooldown_set_at: 0,
      cooldown_message: '',
      requests_15m: 2,
      requests_24h: 20,
      errors_429_15m: 0,
      errors_429_24h: 0,
      last_headers: null,
      webhook: {
        subscription_id: '123',
        last_event_epoch: 1710000000,
        last_event_local: '2024-03-09 10:00',
        last_activity_id: 456,
        last_event_aspect: 'create',
        last_error: '',
      },
    })
  }),
  http.get(`${API}/api/admin/webhooks/status`, () => {
    return HttpResponse.json({
      subscription_id: '123',
      callback_url: 'https://example.com/api/webhooks/strava',
      verify_token_set: true,
      last_event_epoch: 1710000000,
      last_event_local: '2024-03-09 10:00',
      last_activity_id: 456,
      last_event_aspect: 'create',
      last_error: '',
    })
  }),
)

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

it('shows webhook status', async () => {
  renderWithClient(<StravaConnect />)
  expect(await screen.findByText(/Webhooks/i)).toBeTruthy()
  expect(await screen.findByText(/Active/i)).toBeTruthy()
  expect(screen.getByText(/Last event/i)).toBeTruthy()
})
