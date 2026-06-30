import { putToAbsoluteUrl } from '../http-put'

describe('putToAbsoluteUrl', () => {
  it('forwards PUT method, absolute URL, headers and raw body', async () => {
    const url = 'https://blob.example.test/container/part-1?sig=abc'
    const headers = { 'Content-MD5': 'abc=', 'x-ms-blob-type': 'BlockBlob' }
    const body = Buffer.from('encrypted bytes')
    let captured: { input: RequestInfo | URL; init?: RequestInit } | undefined
    const fetchImpl: typeof fetch = async (input, init) => {
      captured = { input, init }
      return new Response('', { status: 201 })
    }

    const result = await putToAbsoluteUrl(url, body, headers, { fetchImpl })

    expect(result).toEqual({ ok: true, status: 201 })
    expect(captured?.input).toBe(url)
    expect(captured?.init?.method).toBe('PUT')
    expect(captured?.init?.headers).toEqual(headers)
    expect(captured?.init?.body).toBe(body)
    expect(captured?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('returns ok false with the HTTP status for non-2xx responses', async () => {
    const fetchImpl: typeof fetch = async () => new Response('', { status: 403 })

    await expect(putToAbsoluteUrl('https://blob.example.test/part', 'body', {}, { fetchImpl })).resolves.toEqual({
      ok: false,
      status: 403,
    })
  })

  it('returns status 0 when fetch throws', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('connection reset')
    }

    await expect(putToAbsoluteUrl('https://blob.example.test/part', 'body', {}, { fetchImpl })).resolves.toEqual({
      ok: false,
      status: 0,
    })
  })

  it('bounds a hanging request with AbortController timeout', async () => {
    const fetchImpl: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal?.aborted) {
          reject(new DOMException('aborted', 'AbortError'))
          return
        }
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })

    await expect(
      putToAbsoluteUrl('https://blob.example.test/part', Buffer.from('body'), {}, { timeoutMs: 5, fetchImpl }),
    ).resolves.toEqual({ ok: false, status: 0 })
  })
})
