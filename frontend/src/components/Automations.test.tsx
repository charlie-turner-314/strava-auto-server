import { render, screen, within, waitForElementToBeRemoved } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Automations } from './Automations'

// In-memory store simulating backend
type Auto = {
  id: string
  name: string
  enabled: boolean
  priority: number
  conditions: any[]
  effects: any[]
  created_at: string
  updated_at: string
}

let store: Auto[] = []
let deleted = false

const API = 'http://localhost:8000'
const server = setupServer(
  http.get(`${API}/api/automations`, () => {
    return HttpResponse.json(store)
  }),
  http.post(`${API}/api/automations`, async ({ request }) => {
    const body = (await request.json()) as any
    const now = new Date().toISOString()
    const created: Auto = {
      id: 'a1',
      name: body.name,
      enabled: Boolean(body.enabled),
      priority: Number(body.priority || 0),
      conditions: body.conditions || [],
      effects: body.effects || [],
      created_at: now,
      updated_at: now,
    }
    store = [created, ...store]
    return HttpResponse.json(created, { status: 201 })
  }),
  http.patch(`${API}/api/automations/:id/enabled`, async ({ params, request }) => {
    const { id } = params as any
    const body = (await request.json()) as any
    store = store.map((a) => (a.id === id ? { ...a, enabled: Boolean(body.enabled) } : a))
    return HttpResponse.json({ id, enabled: Boolean(body.enabled) })
  }),
  http.delete(`${API}/api/automations/:id`, ({ params }) => {
    const { id } = params as any
    store = store.filter((a) => a.id !== id)
    deleted = true
    return new HttpResponse(null, { status: 204 })
  }),
)

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

beforeAll(() => server.listen())
afterEach(() => {
  server.resetHandlers()
  store = []
  deleted = false
})
afterAll(() => server.close())

it('shows empty state and can create, toggle, delete an automation', async () => {
  renderWithClient(<Automations />)
  // Empty state
  expect(await screen.findByText(/No automations yet/i)).toBeTruthy()

  // Create a new automation using builder (default builder mode is on)
  await userEvent.type(screen.getByPlaceholderText(/Name/i), 'My Auto')
  await userEvent.click(screen.getByRole('button', { name: /Create/i }))

  const row = await screen.findByText('My Auto')
  const tr = row.closest('tr')!
  expect(tr).toBeTruthy()
  // Toggle enable off
  const enabledCell = within(tr).getByLabelText(/On|Off/i)?.closest('label') || tr
  const checkbox = within(tr).getByRole('checkbox')
  expect((checkbox as HTMLInputElement).checked).toBe(true)
  await userEvent.click(checkbox)

  // After toggle, checkbox should be unchecked
  const cb2 = await within(tr).findByRole('checkbox')
  expect((cb2 as HTMLInputElement).checked).toBe(false)

  // Delete
  const del = within(tr).getByRole('button', { name: /Delete/i })
  await userEvent.click(del)
  // ensure handler ran
  await screen.findByText('New Automation')
  // wait until msw handler flipped flag
  await (async function waitDeleted(){
    const start = Date.now();
    while(!deleted){
      if(Date.now()-start>1000) break;
      await new Promise((r)=>setTimeout(r,10));
    }
  })()
  expect(deleted).toBe(true)
})
