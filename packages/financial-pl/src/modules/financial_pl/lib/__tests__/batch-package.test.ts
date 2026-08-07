import {
  constants as cryptoConstants,
  createDecipheriv,
  createHash,
  generateKeyPairSync,
  privateDecrypt,
} from 'node:crypto'
import { buildBatchPackage, type BatchInvoiceInput } from '../batch-package'

type ParsedZipEntry = { fileName: string; data: Buffer }

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50

function sha256Base64(data: Buffer): string {
  return createHash('sha256').update(data).digest('base64')
}

function isNonEmptyBase64(value: string): boolean {
  return value.length > 0 && Buffer.from(value, 'base64').length > 0
}

function decryptPackageZip(
  encryptedZip: Buffer,
  encryptedSymmetricKey: string,
  initializationVector: string,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
): Buffer {
  const key = privateDecrypt(
    { key: privateKey, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(encryptedSymmetricKey, 'base64'),
  )
  const iv = Buffer.from(initializationVector, 'base64')
  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([decipher.update(encryptedZip), decipher.final()])
}

function parseLocalFileEntries(zip: Buffer): ParsedZipEntry[] {
  const entries: ParsedZipEntry[] = []
  let offset = 0

  while (offset < zip.length) {
    const signature = zip.readUInt32LE(offset)
    if (signature === CENTRAL_DIRECTORY_SIGNATURE) {
      break
    }

    expect(signature).toBe(LOCAL_FILE_HEADER_SIGNATURE)
    expect(zip.readUInt16LE(offset + 8)).toBe(0)

    const compressedSize = zip.readUInt32LE(offset + 18)
    const uncompressedSize = zip.readUInt32LE(offset + 22)
    const fileNameLength = zip.readUInt16LE(offset + 26)
    const extraFieldLength = zip.readUInt16LE(offset + 28)
    const fileNameStart = offset + 30
    const fileNameEnd = fileNameStart + fileNameLength
    const dataStart = fileNameEnd + extraFieldLength
    const dataEnd = dataStart + compressedSize

    expect(compressedSize).toBe(uncompressedSize)
    entries.push({
      fileName: zip.subarray(fileNameStart, fileNameEnd).toString('utf8'),
      data: zip.subarray(dataStart, dataEnd),
    })
    offset = dataEnd
  }

  expect(zip.readUInt32LE(offset)).toBe(CENTRAL_DIRECTORY_SIGNATURE)
  expect(zip.readUInt32LE(zip.length - 22)).toBe(END_OF_CENTRAL_DIRECTORY_SIGNATURE)
  expect(zip.readUInt16LE(zip.length - 12)).toBe(entries.length)
  return entries
}

describe('buildBatchPackage', () => {
  it('builds an encrypted STORE-mode ZIP package and manifest hashes', () => {
    const invoices: BatchInvoiceInput[] = [
      { fileName: 'fa3-001.xml', xml: '<Faktura><P_1>2026-06-30</P_1><P_2>FV/1</P_2></Faktura>' },
      { fileName: 'fa3-002.xml', xml: '<Faktura><P_1>2026-06-30</P_1><P_2>FV/2</P_2></Faktura>' },
    ]
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

    const batchPackage = buildBatchPackage(invoices, publicKeyPem)
    const plaintextZip = decryptPackageZip(
      batchPackage.encryptedZip,
      batchPackage.encryption.encryptedSymmetricKey,
      batchPackage.encryption.initializationVector,
      privateKey,
    )

    expect(batchPackage.encryptedZip.length).toBeGreaterThan(0)
    expect(batchPackage.encryptedZip.length % 16).toBe(0)
    expect(isNonEmptyBase64(batchPackage.encryption.encryptedSymmetricKey)).toBe(true)
    expect(isNonEmptyBase64(batchPackage.encryption.initializationVector)).toBe(true)
    expect(batchPackage.encryption.initializationVector).toBe(Buffer.from(batchPackage.encryption.initializationVector, 'base64').toString('base64'))

    expect(batchPackage.batchFile).toEqual({
      fileSize: plaintextZip.length,
      fileHash: sha256Base64(plaintextZip),
      compressionType: 'Zip',
    })
    expect(batchPackage.fileParts).toEqual([
      {
        ordinalNumber: 1,
        fileSize: batchPackage.encryptedZip.length,
        fileHash: sha256Base64(batchPackage.encryptedZip),
      },
    ])
    expect(batchPackage.invoiceHashes).toEqual(
      invoices.map((invoice) => ({
        fileName: invoice.fileName,
        sha256: sha256Base64(Buffer.from(invoice.xml, 'utf8')),
      })),
    )

    const entries = parseLocalFileEntries(plaintextZip)
    expect(entries).toEqual(
      invoices.map((invoice) => ({
        fileName: invoice.fileName,
        data: Buffer.from(invoice.xml, 'utf8'),
      })),
    )
  })
})
