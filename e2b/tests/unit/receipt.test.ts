import { describe, it, expect } from 'vitest'
import { parseRequestsBody } from '../../src/receipt'

describe('parseRequestsBody', () => {
  it('parses the {requests:[...]} envelope into typed entries', () => {
    const { count, entries } = parseRequestsBody({
      requests: [
        { method: 'GET', path: '/v1/customers', status: 200 },
        { method: 'POST', path: '/v1/charges', status: 402 },
        { method: 'GET', path: '/hang', status: null },
      ],
    })
    expect(count).toBe(3)
    expect(entries[0]!).toEqual({ method: 'GET', path: '/v1/customers', status: 200 })
    expect(entries[2]!.status).toBeNull()
  })
  it('is not fooled by the string "method" appearing in a body (v1 regex bug)', () => {
    const { count } = parseRequestsBody({ requests: [{ method: 'GET', path: '/x', status: 200, note: 'method method method' }] })
    expect(count).toBe(1)
  })
  it('handles an empty or malformed body', () => {
    expect(parseRequestsBody({}).count).toBe(0)
    expect(parseRequestsBody({ requests: [] }).count).toBe(0)
    expect(parseRequestsBody(null).count).toBe(0)
  })
})
