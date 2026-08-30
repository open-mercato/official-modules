import { createHash } from 'node:crypto'
import * as zlib from 'node:zlib'

import type { KsefEnvironment } from '../../config'
import { resolveJpkGatewayUrl } from '../../config'
import { aes256CbcEncrypt, generateSymmetricKey, rsaPkcs1v15WrapKey } from '../crypto'
import { putToAbsoluteUrl } from '../http-put'
import { signJpkInitUpload } from '../xades'
import { buildJpkInitUploadMetadata, type JpkUploadParts } from './jpk-submission-metadata'

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_STATUS_POLL_ATTEMPTS = 20
const DEFAULT_STATUS_POLL_DELAY_MS = 3_000
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
const ZIP_VERSION_STORE = 20
const UTF8_FILE_NAME_FLAG = 0x0800
const DEFLATE_COMPRESSION_METHOD = 8
const DOS_TIME_MIDNIGHT = 0
const DOS_DATE_1980_01_01 = 0x0021
const ZIP64_LIMIT = 0xffffffff
const ZIP16_LIMIT = 0xffff
const JPK_ZIP_FILE_NAME = 'jpk.xml'

export const JPK_STATUS_POLL_TIMEOUT_ERROR = 'status poll timed out'

export type JpkStatusPollDeps = {
  environment: KsefEnvironment
  fetchImpl?: typeof fetch
  pollAttempts?: number
  pollDelayMs?: number
  requestTimeoutMs?: number
}

export type JpkSubmissionDeps = JpkStatusPollDeps & {
  signer: { certificatePem: string; privateKeyPem: string }
  mfPublicCertPem: string
  /** TEST-only: ask the MF gateway to validate the qualified-signature trust path. */
  validateQualifiedSignature?: boolean
  zip?: (xml: string) => Buffer
  onReference?: (referenceNumber: string) => Promise<void> | void
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

type ZipEntry = {
  fileNameBytes: Buffer
  data: Buffer
  compressedData: Buffer
  crc32: number
  localHeaderOffset: number
}

type PollOptions = {
  attempts: number
  delayMs: number
  requestTimeoutMs: number
}

export function defaultZip(xml: string): Buffer {
  return buildSingleEntryDeflateZip(JPK_ZIP_FILE_NAME, Buffer.from(xml, 'utf8'))
}

function buildSingleEntryDeflateZip(fileName: string, data: Buffer): Buffer {
  const fileNameBytes = Buffer.from(fileName, 'utf8')
  if (fileNameBytes.length === 0) throw new Error('[internal] JPK ZIP entry file name must be non-empty')
  assertZip16(fileNameBytes.length, `file name length for ${fileName}`)
  assertZip32(data.length, `file size for ${fileName}`)
  const compressedData = zlib.deflateRawSync(data)
  assertZip32(compressedData.length, `compressed file size for ${fileName}`)

  const entry: ZipEntry = {
    fileNameBytes,
    data,
    compressedData,
    crc32: computeCrc32(data),
    localHeaderOffset: 0,
  }
  const localHeader = localFileHeader(entry)
  const centralDirectoryOffset = localHeader.length + fileNameBytes.length + compressedData.length
  assertZip32(centralDirectoryOffset, 'central directory offset')

  const centralHeader = centralDirectoryHeader(entry)
  const centralDirectorySize = centralHeader.length + fileNameBytes.length
  assertZip32(centralDirectorySize, 'central directory size')

  return Buffer.concat([
    localHeader,
    fileNameBytes,
    compressedData,
    centralHeader,
    fileNameBytes,
    endOfCentralDirectory(1, centralDirectorySize, centralDirectoryOffset),
  ])
}

function localFileHeader(entry: ZipEntry): Buffer {
  const header = Buffer.allocUnsafe(30)
  header.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0)
  header.writeUInt16LE(ZIP_VERSION_STORE, 4)
  header.writeUInt16LE(UTF8_FILE_NAME_FLAG, 6)
  header.writeUInt16LE(DEFLATE_COMPRESSION_METHOD, 8)
  header.writeUInt16LE(DOS_TIME_MIDNIGHT, 10)
  header.writeUInt16LE(DOS_DATE_1980_01_01, 12)
  header.writeUInt32LE(entry.crc32, 14)
  header.writeUInt32LE(entry.compressedData.length, 18)
  header.writeUInt32LE(entry.data.length, 22)
  header.writeUInt16LE(entry.fileNameBytes.length, 26)
  header.writeUInt16LE(0, 28)
  return header
}

function centralDirectoryHeader(entry: ZipEntry): Buffer {
  const header = Buffer.allocUnsafe(46)
  header.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0)
  header.writeUInt16LE(ZIP_VERSION_STORE, 4)
  header.writeUInt16LE(ZIP_VERSION_STORE, 6)
  header.writeUInt16LE(UTF8_FILE_NAME_FLAG, 8)
  header.writeUInt16LE(DEFLATE_COMPRESSION_METHOD, 10)
  header.writeUInt16LE(DOS_TIME_MIDNIGHT, 12)
  header.writeUInt16LE(DOS_DATE_1980_01_01, 14)
  header.writeUInt32LE(entry.crc32, 16)
  header.writeUInt32LE(entry.compressedData.length, 20)
  header.writeUInt32LE(entry.data.length, 24)
  header.writeUInt16LE(entry.fileNameBytes.length, 28)
  header.writeUInt16LE(0, 30)
  header.writeUInt16LE(0, 32)
  header.writeUInt16LE(0, 34)
  header.writeUInt16LE(0, 36)
  header.writeUInt32LE(0, 38)
  header.writeUInt32LE(entry.localHeaderOffset, 42)
  return header
}

function endOfCentralDirectory(
  entryCount: number,
  centralDirectorySize: number,
  centralDirectoryOffset: number,
): Buffer {
  const record = Buffer.allocUnsafe(22)
  record.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0)
  record.writeUInt16LE(0, 4)
  record.writeUInt16LE(0, 6)
  record.writeUInt16LE(entryCount, 8)
  record.writeUInt16LE(entryCount, 10)
  record.writeUInt32LE(centralDirectorySize, 12)
  record.writeUInt32LE(centralDirectoryOffset, 16)
  record.writeUInt16LE(0, 20)
  return record
}

function computeCrc32(data: Buffer): number {
  const zlibCrc32: unknown = (zlib as { crc32?: unknown }).crc32
  if (typeof zlibCrc32 === 'function') {
    return (zlibCrc32 as (input: Buffer) => number)(data) >>> 0
  }
  return softwareCrc32(data)
}

const CRC32_TABLE = createCrc32Table()

function createCrc32Table(): Uint32Array {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
}

function softwareCrc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function assertZip16(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > ZIP16_LIMIT) {
    throw new Error(`[internal] ZIP ${label} must fit in 16 bits`)
  }
}

function assertZip32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > ZIP64_LIMIT) {
    throw new Error(`[internal] ZIP ${label} requires ZIP64, which is not supported for JPK submissions`)
  }
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

function envPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function optionPositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function resolvePollOptions(deps: Partial<JpkStatusPollDeps> = {}): PollOptions {
  return {
    attempts: optionPositiveInteger(
      deps.pollAttempts,
      envPositiveInteger('OM_JPK_STATUS_POLL_ATTEMPTS', DEFAULT_STATUS_POLL_ATTEMPTS),
    ),
    delayMs: optionPositiveInteger(
      deps.pollDelayMs,
      envPositiveInteger('OM_JPK_STATUS_POLL_DELAY_MS', DEFAULT_STATUS_POLL_DELAY_MS),
    ),
    requestTimeoutMs: optionPositiveInteger(
      deps.requestTimeoutMs,
      envPositiveInteger('OM_JPK_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS),
    ),
  }
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
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

async function postXml(fetchImpl: typeof fetch, url: string, body: string, timeoutMs: number): Promise<Response> {
  return fetchWithTimeout(fetchImpl, url, {
    method: 'POST',
    headers: { 'content-type': 'application/xml; charset=utf-8' },
    body,
  }, timeoutMs)
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<Response> {
  return fetchWithTimeout(fetchImpl, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, timeoutMs)
}

async function gatewayHttpError(label: string, response: Response): Promise<string> {
  let detail = ''
  try {
    const body = toRecord(await readJson(response))
    const code = body?.Code ?? body?.code
    const message = body?.Message ?? body?.message
    const fields = [code, message].filter(
      (value): value is string | number => typeof value === 'string' || typeof value === 'number',
    )
    if (fields.length > 0) detail = `: ${fields.join(' — ')}`
  } catch {
    // The status code remains actionable when an upstream proxy returns a non-JSON error body.
  }
  return `${label} failed with HTTP ${response.status}${detail}`
}

function validateQualifiedSignatureOnTest(deps: JpkSubmissionDeps): boolean {
  if (deps.environment !== 'test') return false
  if (typeof deps.validateQualifiedSignature === 'boolean') return deps.validateQualifiedSignature
  return process.env.OM_JPK_VALIDATE_QUALIFIED_SIGNATURE === 'true'
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
  options: PollOptions,
): Promise<JpkSubmissionResult> {
  let lastStatus = 'unknown'

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    const response = await fetchWithTimeout(fetchImpl, statusUrl, { method: 'GET' }, options.requestTimeoutMs)
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
    if (attempt < options.attempts) await sleep(options.delayMs)
  }

  return {
    ok: false,
    referenceNumber,
    status: lastStatus,
    error: JPK_STATUS_POLL_TIMEOUT_ERROR,
  }
}

export async function pollJpkStatus(referenceNumber: string, deps: JpkStatusPollDeps): Promise<JpkSubmissionResult> {
  try {
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
      return { ok: false, referenceNumber, error: '[internal] fetch is not available' }
    }

    const gatewayUrl = resolveJpkGatewayUrl(deps.environment)
    return await pollStatus(
      fetchImpl,
      absoluteApiUrl(gatewayUrl, `/api/Storage/Status/${encodeURIComponent(referenceNumber)}`),
      referenceNumber,
      resolvePollOptions(deps),
    )
  } catch (error) {
    return { ok: false, referenceNumber, error: errorMessage(error) }
  }
}

export async function submitJpk(jpkXml: string, deps: JpkSubmissionDeps): Promise<JpkSubmissionResult> {
  try {
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') return { ok: false, error: '[internal] fetch is not available' }
    const pollOptions = resolvePollOptions(deps)

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
    const validateSignature = validateQualifiedSignatureOnTest(deps)
    const initUploadPath = validateSignature
      ? '/api/Storage/InitUploadSigned?enableValidateQualifiedSignature=true'
      : '/api/Storage/InitUploadSigned'

    const initResponse = await postXml(
      fetchImpl,
      absoluteApiUrl(gatewayUrl, initUploadPath),
      signedMetadataXml,
      pollOptions.requestTimeoutMs,
    )
    if (!initResponse.ok) return { ok: false, error: await gatewayHttpError('JPK InitUploadSigned', initResponse) }

    const initPayload = parseInitUploadResponse(await readJson(initResponse))
    if (!initPayload) return { ok: false, error: 'JPK InitUploadSigned returned an invalid response' }
    try {
      await deps.onReference?.(initPayload.ReferenceNumber)
    } catch (error) {
      return { ok: false, referenceNumber: initPayload.ReferenceNumber, error: errorMessage(error) }
    }
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
        timeoutMs: pollOptions.requestTimeoutMs,
      })
      if (!uploadResult.ok) {
        return {
          ok: false,
          referenceNumber: initPayload.ReferenceNumber,
          error: `JPK blob upload failed with HTTP ${uploadResult.status}`,
        }
      }
    }

    const finishResponse = await postJson(
      fetchImpl,
      absoluteApiUrl(gatewayUrl, '/api/Storage/FinishUpload'),
      {
        ReferenceNumber: initPayload.ReferenceNumber,
        AzureBlobNameList: initPayload.RequestToUploadFileList.map((entry) => entry.BlobName),
      },
      pollOptions.requestTimeoutMs,
    )
    if (!finishResponse.ok) {
      return {
        ok: false,
        referenceNumber: initPayload.ReferenceNumber,
        error: await gatewayHttpError('JPK FinishUpload', finishResponse),
      }
    }

    return await pollStatus(
      fetchImpl,
      absoluteApiUrl(gatewayUrl, `/api/Storage/Status/${encodeURIComponent(initPayload.ReferenceNumber)}`),
      initPayload.ReferenceNumber,
      pollOptions,
    )
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}
