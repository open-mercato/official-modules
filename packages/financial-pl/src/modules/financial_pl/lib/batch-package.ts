import { createPublicKey, X509Certificate, type KeyObject } from 'node:crypto'
import * as zlib from 'node:zlib'
import {
  aes256CbcEncrypt,
  generateSymmetricKey,
  sha256Base64,
  wrapSymmetricKey,
} from './crypto'

export type BatchInvoiceInput = { fileName: string; xml: string }

export type BatchPackage = {
  encryptedZip: Buffer
  encryption: { encryptedSymmetricKey: string; initializationVector: string }
  batchFile: { fileSize: number; fileHash: string }
  fileParts: { ordinalNumber: number; fileName: string; fileSize: number; fileHash: string }[]
  invoiceHashes: { fileName: string; sha256: string }[]
}

type ZipEntry = {
  fileName: string
  fileNameBytes: Buffer
  data: Buffer
  crc32: number
  localHeaderOffset: number
}

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
const ZIP_VERSION_STORE = 20
const UTF8_FILE_NAME_FLAG = 0x0800
const STORE_COMPRESSION_METHOD = 0
const DOS_TIME_MIDNIGHT = 0
const DOS_DATE_1980_01_01 = 0x0021
const ZIP64_LIMIT = 0xffffffff
const ZIP16_LIMIT = 0xffff
const SINGLE_PART_FILE_NAME = 'batch-part-1.zip.enc'

/** Build a single-part encrypted batch package from FA(3) invoice XMLs (SPEC-015 F6). */
export function buildBatchPackage(invoices: BatchInvoiceInput[], mfPublicKeyPem: string): BatchPackage {
  const zipBytes = buildStoreModeZip(invoices)
  const material = generateSymmetricKey()
  const encryptedZip = aes256CbcEncrypt(zipBytes, material)
  const mfPublicKey = resolvePublicKey(mfPublicKeyPem)

  // [internal] SPEC-015 F6 follow-up: split encrypted batch parts at <=100 MB for multi-part sessions.
  return {
    encryptedZip,
    encryption: {
      encryptedSymmetricKey: wrapSymmetricKey(material, mfPublicKey),
      initializationVector: material.iv.toString('base64'),
    },
    batchFile: {
      fileSize: zipBytes.length,
      fileHash: sha256Base64(zipBytes),
    },
    fileParts: [
      {
        ordinalNumber: 1,
        fileName: SINGLE_PART_FILE_NAME,
        fileSize: encryptedZip.length,
        fileHash: sha256Base64(encryptedZip),
      },
    ],
    invoiceHashes: invoices.map((invoice) => ({
      fileName: invoice.fileName,
      sha256: sha256Base64(Buffer.from(invoice.xml, 'utf8')),
    })),
  }
}

function buildStoreModeZip(invoices: BatchInvoiceInput[]): Buffer {
  assertZip16(invoices.length, 'entry count')

  const entries: ZipEntry[] = []
  const localParts: Buffer[] = []
  let offset = 0

  for (const invoice of invoices) {
    const fileNameBytes = Buffer.from(invoice.fileName, 'utf8')
    if (fileNameBytes.length === 0) {
      throw new Error('[internal] batch invoice fileName must be non-empty')
    }
    assertZip16(fileNameBytes.length, `file name length for ${invoice.fileName}`)

    const data = Buffer.from(invoice.xml, 'utf8')
    assertZip32(data.length, `file size for ${invoice.fileName}`)

    const entry: ZipEntry = {
      fileName: invoice.fileName,
      fileNameBytes,
      data,
      crc32: computeCrc32(data),
      localHeaderOffset: offset,
    }
    const localHeader = localFileHeader(entry)
    localParts.push(localHeader, fileNameBytes, data)
    offset += localHeader.length + fileNameBytes.length + data.length
    assertZip32(offset, 'local file data offset')
    entries.push(entry)
  }

  const centralDirectoryOffset = offset
  const centralParts = entries.flatMap((entry) => [centralDirectoryHeader(entry), entry.fileNameBytes])
  const centralDirectorySize = centralParts.reduce((total, part) => total + part.length, 0)
  assertZip32(centralDirectoryOffset, 'central directory offset')
  assertZip32(centralDirectorySize, 'central directory size')

  const eocd = endOfCentralDirectory(entries.length, centralDirectorySize, centralDirectoryOffset)
  return Buffer.concat([...localParts, ...centralParts, eocd])
}

function localFileHeader(entry: ZipEntry): Buffer {
  const header = Buffer.allocUnsafe(30)
  header.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0)
  header.writeUInt16LE(ZIP_VERSION_STORE, 4)
  header.writeUInt16LE(UTF8_FILE_NAME_FLAG, 6)
  header.writeUInt16LE(STORE_COMPRESSION_METHOD, 8)
  header.writeUInt16LE(DOS_TIME_MIDNIGHT, 10)
  header.writeUInt16LE(DOS_DATE_1980_01_01, 12)
  header.writeUInt32LE(entry.crc32, 14)
  header.writeUInt32LE(entry.data.length, 18)
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
  header.writeUInt16LE(STORE_COMPRESSION_METHOD, 10)
  header.writeUInt16LE(DOS_TIME_MIDNIGHT, 12)
  header.writeUInt16LE(DOS_DATE_1980_01_01, 14)
  header.writeUInt32LE(entry.crc32, 16)
  header.writeUInt32LE(entry.data.length, 20)
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

function resolvePublicKey(publicKeyPem: string): KeyObject {
  const trimmed = publicKeyPem.trim()
  if (trimmed.includes('BEGIN CERTIFICATE')) {
    return new X509Certificate(trimmed).publicKey
  }

  try {
    return createPublicKey(trimmed)
  } catch {
    const der = Buffer.from(trimmed, 'base64')
    try {
      return new X509Certificate(der).publicKey
    } catch {
      return createPublicKey({ key: der, format: 'der', type: 'spki' })
    }
  }
}

function assertZip16(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > ZIP16_LIMIT) {
    throw new Error(`[internal] ZIP ${label} must fit in 16 bits`)
  }
}

function assertZip32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > ZIP64_LIMIT) {
    throw new Error(`[internal] ZIP ${label} requires ZIP64, which is not supported for KSeF batch packages`)
  }
}
