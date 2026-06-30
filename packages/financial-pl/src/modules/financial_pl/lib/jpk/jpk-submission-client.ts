import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'

import type { KsefEnvironment } from '../../config'
import { resolveJpkGatewayUrl } from '../../config'
import { aes256CbcEncrypt, generateSymmetricKey, rsaPkcs1v15WrapKey } from '../crypto'
import { putToAbsoluteUrl } from '../http-put'
import { signJpkInitUpload } from '../xades'
import { buildJpkInitUploadMetadata, type JpkUploadParts } from './jpk-submission-metadata'

const REQUEST_TIMEOUT_MS = 15_000
const STATUS_POLL_ATTEMPTS = 5
const STATUS_POLL_DELAY_MS = 100

export type JpkSubmissionDeps = {
  environment: KsefEnvironment
  signer: { certificatePem: string; privateKeyPem: string }
  mfPublicCertPem: string
  fetchImpl?: typeof fetch
  zip?: (xml: string) => Buffer
}

export type JpkSubmissionResult =
  | { ok: true; referenceNumber: string; status: string; upoXml?: string }
  | { ok: false; referenceNumber?: string; status?: string; error: string }

type UploadHeader = { Key: string; Value: string }

type UploadRequest = {
  BlobName: string
  Url: string
  Method?: string
  HeaderList?: UploadHeader[]
}

type InitUploadResponse = {
  ReferenceNumber: string
  RequestToUploadFileList: UploadRequest[]
}

type StatusPayload = {
  status: string
  upoXml?: string
  terminalSuccess: boolean
  terminalFailure: boolean
  error?: string
}

function defaultZip(xml: string): Buffer {
  // [internal] confirm ZIP container vs raw-deflate against the MF spec.
  return deflateRawSync(Buffer.from(xml, 'utf8'))
}

function hashBase64(algorithm: 'md5' | 'sha256', body: Buffer): string {
  return createHash(algorithm).update(body).digest('base64')
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function parseUploadHeader(value: unknown): UploadHeader | undefined {
  const record = toRecord(value)
  const key = record?.Key
  const headerValue = record?.Value
  if (typeof key !== 'string' || typeof headerValue !== 'string') return undefined
  return { Key: key, Value: headerValue }
}

function parseUploadRequest(value: unknown): UploadRequest | undefined {
  const record = toRecord(value)
  if (!record) return undefined
  const blobName = record.BlobName
  const url = record.Url
  if (typeof blobName !== 'string' || typeof url !== 'string') return undefined

  const headerListValue = record.HeaderList
  const headerList = Array.isArray(headerListValue)
    ? headerListValue.map(parseUploadHeader).filter((item): item is UploadHeader => Boolean(item))
    : undefined

  return {
    BlobName: blobName,
    Url: url,
    Method: typeof record.Method === 'string' ? record.Method : undefined,
    HeaderList: headerList,
  }
}

function parseInitUploadResponse(value: unknown): InitUploadResponse | undefined {
  const record = toRecord(value)
  const referenceNumber = record?.ReferenceNumber
  const uploadList = record?.RequestToUploadFileList
  if (typeof referenceNumber !== 'string' || !Array.isArray(uploadList)) return undefined

  const requests = uploadList.map(parseUploadRequest).filter((item): item is UploadRequest => Boolean(item))
  if (requests.length !== uploadList.length) return undefined

  return { ReferenceNumber: referenceNumber, RequestToUploadFileList: requests }
}

function uploadHeaders(entry: UploadRequest): Record<string, string> {
  return (entry.HeaderList ?? []).reduce<Record<string, string>>((headers, header) => {
    headers[header.Key] = header.Value
    return headers
  }, {})
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '[internal] JPK submission failed'
}

function absoluteApiUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return {}
  return JSON.parse(text) as unknown
}

async function postXml(fetchImpl: typeof fetch, url: string, body: string): Promise<Response> {
  return fetchWithTimeout(fetchImpl, url, {
    method: 'POST',
    headers: { 'content-type': 'application/xml; charset=utf-8' },
    body,
  })
}

async function postJson(fetchImpl: typeof fetch, url: string, body: Record<string, string>): Promise<Response> {
  return fetchWithTimeout(fetchImpl, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function readStatusPayload(value: unknown): StatusPayload {
  const record = toRecord(value) ?? {}
  const rawStatus =
    record.Status ?? record.status ?? record.ProcessingCode ?? record.processingCode ?? record.Code ?? record.code
  const status = typeof rawStatus === 'number' || typeof rawStatus === 'string' ? String(rawStatus) : 'unknown'
  const upo = record.Upo ?? record.upo ?? record.UpoXml ?? record.upoXml
  const description = record.Description ?? record.description ?? record.Message ?? record.message
  const normalized = status.toLowerCase()
  const upoXml = typeof upo === 'string' && upo.length > 0 ? upo : undefined
  const terminalSuccess =
    Boolean(upoXml) ||
    normalized === '200' ||
    normalized === '201' ||
    normalized.includes('success') ||
    normalized.includes('succeeded') ||
    normalized.includes('completed') ||
    normalized.includes('finished') ||
    normalized === 'ok'
  const terminalFailure =
    normalized.includes('fail') ||
    normalized.includes('reject') ||
    normalized.includes('error') ||
    normalized.includes('blad') ||
    normalized.includes('błąd') ||
    normalized.startsWith('4') ||
    normalized.startsWith('5')

  return {
    status,
    upoXml,
    terminalSuccess,
    terminalFailure,
    error: typeof description === 'string' && description.length > 0 ? description : undefined,
  }
}

async function pollStatus(
  fetchImpl: typeof fetch,
  statusUrl: string,
  referenceNumber: string,
): Promise<JpkSubmissionResult> {
  let lastStatus = 'unknown'
  let lastError: string | undefined

  for (let attempt = 1; attempt <= STATUS_POLL_ATTEMPTS; attempt += 1) {
    const response = await fetchWithTimeout(fetchImpl, statusUrl, { method: 'GET' })
    if (!response.ok) {
      return {
        ok: false,
        referenceNumber,
        status: String(response.status),
        error: `JPK status request failed with HTTP ${response.status}`,
      }
    }

    const statusPayload = readStatusPayload(await readJson(response))
    lastStatus = statusPayload.status
    lastError = statusPayload.error
    if (statusPayload.terminalSuccess) {
      return {
        ok: true,
        referenceNumber,
        status: statusPayload.status,
        ...(statusPayload.upoXml ? { upoXml: statusPayload.upoXml } : {}),
      }
    }
    if (statusPayload.terminalFailure) {
      return {
        ok: false,
        referenceNumber,
        status: statusPayload.status,
        error: statusPayload.error ?? `JPK submission finished with status ${statusPayload.status}`,
      }
    }
    if (attempt < STATUS_POLL_ATTEMPTS) await sleep(STATUS_POLL_DELAY_MS)
  }

  return {
    ok: false,
    referenceNumber,
    status: lastStatus,
    error: lastError ?? 'JPK submission status polling timed out',
  }
}

export async function submitJpk(jpkXml: string, deps: JpkSubmissionDeps): Promise<JpkSubmissionResult> {
  try {
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') return { ok: false, error: '[internal] fetch is not available' }

    const zipped = deps.zip ? deps.zip(jpkXml) : defaultZip(jpkXml)
    const material = generateSymmetricKey()
    const encryptedPart = aes256CbcEncrypt(zipped, material)
    const uploadParts: JpkUploadParts = [{ encryptedPart, ordinalNumber: 1, fileName: 'jpk-part-1.bin' }]
    const metadataXml = buildJpkInitUploadMetadata({
      jpkXml,
      documentSha256Base64: hashBase64('sha256', Buffer.from(jpkXml, 'utf8')),
      documentSize: Buffer.byteLength(jpkXml, 'utf8'),
      encryptedKeyBase64: rsaPkcs1v15WrapKey(material.key, deps.mfPublicCertPem).toString('base64'),
      initializationVectorBase64: material.iv.toString('base64'),
      parts: uploadParts.map((part) => ({
        ordinalNumber: part.ordinalNumber,
        fileName: part.fileName,
        partMd5Base64: hashBase64('md5', part.encryptedPart),
        partSize: part.encryptedPart.length,
      })),
    })
    const signedMetadataXml = await signJpkInitUpload(metadataXml, deps.signer)
    const gatewayUrl = resolveJpkGatewayUrl(deps.environment)

    const initResponse = await postXml(
      fetchImpl,
      absoluteApiUrl(gatewayUrl, '/api/Storage/InitUploadSigned'),
      signedMetadataXml,
    )
    if (!initResponse.ok) return { ok: false, error: `JPK InitUploadSigned failed with HTTP ${initResponse.status}` }

    const initPayload = parseInitUploadResponse(await readJson(initResponse))
    if (!initPayload) return { ok: false, error: 'JPK InitUploadSigned returned an invalid response' }
    if (initPayload.RequestToUploadFileList.length < uploadParts.length) {
      return {
        ok: false,
        referenceNumber: initPayload.ReferenceNumber,
        error: 'JPK InitUploadSigned did not return upload URLs for every part',
      }
    }

    for (let index = 0; index < uploadParts.length; index += 1) {
      const uploadEntry = initPayload.RequestToUploadFileList[index]
      const part = uploadParts[index]
      const uploadResult = await putToAbsoluteUrl(uploadEntry.Url, part.encryptedPart, uploadHeaders(uploadEntry), {
        fetchImpl,
        timeoutMs: REQUEST_TIMEOUT_MS,
      })
      if (!uploadResult.ok) {
        return {
          ok: false,
          referenceNumber: initPayload.ReferenceNumber,
          error: `JPK blob upload failed with HTTP ${uploadResult.status}`,
        }
      }
    }

    const finishResponse = await postJson(fetchImpl, absoluteApiUrl(gatewayUrl, '/api/Storage/FinishUpload'), {
      ReferenceNumber: initPayload.ReferenceNumber,
    })
    if (!finishResponse.ok) {
      return {
        ok: false,
        referenceNumber: initPayload.ReferenceNumber,
        error: `JPK FinishUpload failed with HTTP ${finishResponse.status}`,
      }
    }

    return await pollStatus(
      fetchImpl,
      absoluteApiUrl(gatewayUrl, `/api/Storage/Status/${encodeURIComponent(initPayload.ReferenceNumber)}`),
      initPayload.ReferenceNumber,
    )
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}
