/**
 * KSeF TEST API mock — Node `--import` preload.
 *
 * Loaded via NODE_OPTIONS="--import <this>" so it patches global `fetch` in EVERY
 * node process the dev runner spawns (the Next server AND any separate queue-worker
 * process), which a Next `instrumentation.ts` hook cannot reach. Active only when
 * OM_KSEF_MOCK is truthy. Faking *.ksef.mf.gov.pl lets the full
 * create → send → status → UPO flow run locally with no real token or network.
 *
 * Activity is appended to OM_KSEF_MOCK_LOG (if set) so it is observable even when
 * the compact dev runner swallows stdout.
 */
import fs from 'node:fs'

const enabled = /^(1|true|yes|on)$/i.test(process.env.OM_KSEF_MOCK ?? '')
const LOG_FILE = process.env.OM_KSEF_MOCK_LOG
function logLine(msg) {
  if (!LOG_FILE) return
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [pid ${process.pid}] ${msg}\n`)
  } catch {
    /* ignore */
  }
}

// Base64-encoded DER of the throwaway cert. KSeF returns the `certificate` field
// as base64 DER (no PEM header), and the module does Buffer.from(cert,'base64') →
// X509Certificate, so this MUST be the DER body, not a full PEM.
const MOCK_CERT_DER_B64 =
  'MIICrjCCAZYCCQDsr7szCUicODANBgkqhkiG9w0BAQsFADAZMRcwFQYDVQQDDA5LU2VGIE1vY2sgVEVTVDAeFw0yNjA3MDcxOTMwMTBaFw0zNjA3MDQxOTMwMTBaMBkxFzAVBgNVBAMMDktTZUYgTW9jayBURVNUMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsZT8+sIlz42+UKjt2JtpKr8nUCljztV1a1UI3hiMm+bTaTMm2VKZflFcVhP54gTR+xXA2qA/XCWfcghW2jNs0Ol12948y4+t6ziQ/ZFu5q0/lha9orvK+1a4z46+2zSsCDfMDsGnk4m6r9CMurdn3rQOZq//Nj7ouI1CGXcO1mI7ekbyXNXewdKcsxargcARTyhEvjoGV8sos/foz8E7dGmRdsgKhxeNsCdn0XnLdlBF/bz7g+BwPLPNkXeJ99U5KGvPnqi7gXyLPv/aLtv0TWtIJTp8QSx0msSvCnSfZfz1YJ8uR6rC9S0/rBlwbYLyK54Zs/teDsAJOLXCK2kk5wIDAQABMA0GCSqGSIb3DQEBCwUAA4IBAQCGTaibDgco2dLTJNNutbMb/f6IRhV62Aro/SX/6SZZHPHJpX0jc/bOI5EXj6VXdXSLZX3CtangrPPXxZ1e4SUm5L7RzH0L+A5EoXQVKezvZQBvk8aW8dO9QIGfYomZn2RKaObgqJLoN08tTB5+ecC8j9eOsKG1HjRAPX7fPCEwXqs2iIc/D2cdnJYBx49zjG5vWCL+72DOtxC0r0dZH/R5eKiTOa1H9SHFo4HpbFW4RKgNTOX093REfmWhZE8TOr15z3k0Dohyo+WK2kSzr0dLl2bhkSpd2WKf8aK8po+dgDbgJDzoVb0xEMsP3TPzhfN47RYJcluXmRw0CURZ0AKp'

const KSEF_HOST_RE = /(^|\.)ksef\.mf\.gov\.pl$/
let lastContextNip = '0000000000'

function stableHex(seed, len) {
  let h = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  let out = ''
  let n = h >>> 0
  const alphabet = '0123456789ABCDEF'
  while (out.length < len) {
    out += alphabet[n % 16]
    n = Math.floor(n / 16) + seed.length + out.length
  }
  return out.slice(0, len)
}
function ksefNumberFor(ref) {
  return `${lastContextNip}-20260707-${stableHex(ref, 10)}-${stableHex('cs' + ref, 2)}`
}
function upoXml(ksefNumber) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Potwierdzenie xmlns="http://ksef.mf.gov.pl/schema/gtw/svc/upo/2.0">\n` +
    `  <NumerReferencyjny>${ksefNumber}</NumerReferencyjny>\n` +
    `  <NumerKSeFDokumentu>${ksefNumber}</NumerKSeFDokumentu>\n` +
    `  <DataPrzyjecia>2026-07-07T10:00:00Z</DataPrzyjecia>\n` +
    `  <Srodowisko>Test (mock)</Srodowisko>\n` +
    `  <Podpis>MOCK-UPO-SIGNATURE</Podpis>\n` +
    `</Potwierdzenie>`
  )
}
function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
}
function xmlResponse(text) {
  return new Response(text, { status: 200, headers: { 'content-type': 'application/xml' } })
}

function handleKsef(method, path, body) {
  if (method === 'GET' && path === '/security/public-key-certificates') {
    return jsonResponse(200, {
      certificates: [
        { publicKeyId: 'mock-sym', certificate: MOCK_CERT_DER_B64, usage: ['SymmetricKeyEncryption'], validFrom: '2026-01-01T00:00:00Z' },
        { publicKeyId: 'mock-tok', certificate: MOCK_CERT_DER_B64, usage: ['KsefTokenEncryption'], validFrom: '2026-01-01T00:00:00Z' },
      ],
    })
  }
  if (method === 'POST' && path === '/auth/challenge') {
    return jsonResponse(201, { challenge: '20260707-CR-MOCK-0001', timestamp: '2026-07-07T10:00:00.000Z' })
  }
  if (method === 'POST' && (path === '/auth/ksef-token' || path === '/auth/xades-signature')) {
    try {
      if (body) {
        const parsed = JSON.parse(body)
        if (parsed?.contextIdentifier?.value) lastContextNip = parsed.contextIdentifier.value
      }
    } catch {
      /* xades body is XML */
    }
    if (body && body.includes('<Nip>')) {
      const m = body.match(/<Nip>(\d{10})<\/Nip>/)
      if (m) lastContextNip = m[1]
    }
    return jsonResponse(201, { referenceNumber: 'AUTH-REF-MOCK', authenticationToken: 'mock-auth-token' })
  }
  if (method === 'GET' && /^\/auth\/[^/]+$/.test(path)) {
    return jsonResponse(200, { status: { code: 200, description: 'Uwierzytelniono' } })
  }
  if (method === 'POST' && (path === '/auth/token/redeem' || path === '/auth/token/refresh')) {
    return jsonResponse(200, { accessToken: 'mock-access-token', refreshToken: 'mock-refresh-token' })
  }
  if (method === 'POST' && path === '/sessions/online') {
    return jsonResponse(201, { referenceNumber: 'SES-MOCK-0001', validUntil: '2026-07-07T11:00:00Z' })
  }
  if (method === 'POST' && /^\/sessions\/online\/[^/]+\/invoices$/.test(path)) {
    return jsonResponse(202, { referenceNumber: 'INV-' + stableHex(body ?? String(path.length), 8) })
  }
  if (method === 'POST' && /^\/sessions\/online\/[^/]+\/close$/.test(path)) {
    return jsonResponse(200, {})
  }
  let m = path.match(/^\/sessions\/[^/]+\/invoices\/([^/]+)\/upo$/)
  if (method === 'GET' && m) return xmlResponse(upoXml(ksefNumberFor(m[1])))
  m = path.match(/^\/sessions\/[^/]+\/invoices\/ksef\/([^/]+)\/upo$/)
  if (method === 'GET' && m) return xmlResponse(upoXml(decodeURIComponent(m[1])))
  m = path.match(/^\/sessions\/[^/]+\/invoices\/([^/]+)$/)
  if (method === 'GET' && m) {
    return jsonResponse(200, { status: { code: 200, description: 'Przyjęto' }, ksefNumber: ksefNumberFor(m[1]) })
  }
  if (method === 'GET' && /^\/sessions\/[^/]+$/.test(path)) {
    return jsonResponse(200, { status: { code: 200, description: 'Sesja przetworzona' } })
  }
  if (method === 'POST' && path.startsWith('/invoices/query/metadata')) {
    return jsonResponse(200, { invoices: [], hasMore: false, isTruncated: false })
  }
  if (method === 'GET' && path === '/certificates/limits') {
    return jsonResponse(200, { canEnroll: true, remaining: 10 })
  }
  if (method === 'GET' && path === '/certificates/enrollments/data') {
    return jsonResponse(200, { commonName: 'KSeF Mock', organizationIdentifier: `VATPL-${lastContextNip}` })
  }
  return jsonResponse(200, {})
}

if (enabled) {
  const g = globalThis
  if (!g.__omKsefMockInstalled) {
    g.__omKsefMockInstalled = true
    const originalFetch = g.fetch
    g.fetch = async (input, init) => {
      try {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
        if (url) {
          const u = new URL(url)
          if (KSEF_HOST_RE.test(u.hostname)) {
            const reqMethod = init?.method ?? (typeof input === 'object' && input && 'method' in input ? input.method : undefined)
            const method = String(reqMethod ?? 'GET').toUpperCase()
            const path = u.pathname.replace(/^\/v2/, '')
            const body = typeof init?.body === 'string' ? init.body : undefined
            logLine(`${method} ${path}`)
            return handleKsef(method, path, body)
          }
        }
      } catch (err) {
        logLine(`passthrough-error ${err?.message ?? err}`)
      }
      return originalFetch(input, init)
    }
    logLine('KSeF mock installed')
  }
}
