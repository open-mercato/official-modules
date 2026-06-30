import { createHash } from 'node:crypto'

import { buildJpkAuthData, buildJpkInitUploadMetadata } from '../jpk-submission-metadata'

describe('buildJpkInitUploadMetadata', () => {
  it('emits document SHA-256, RSA key block, IV and per-part MD5 metadata', () => {
    const jpkXml = '<JPK><Naglowek /></JPK>'
    const documentSha256Base64 = createHash('sha256').update(Buffer.from(jpkXml, 'utf8')).digest('base64')
    const partMd5Base64 = createHash('md5').update(Buffer.from('encrypted-part')).digest('base64')

    const xml = buildJpkInitUploadMetadata({
      jpkXml,
      documentSha256Base64,
      documentSize: Buffer.byteLength(jpkXml, 'utf8'),
      encryptedKeyBase64: 'wrapped-key==',
      initializationVectorBase64: 'initial-vector==',
      parts: [{ ordinalNumber: 1, fileName: 'jpk-part-1.bin', partMd5Base64, partSize: 14 }],
    })

    expect(xml).toContain('<Document>')
    expect(xml).toContain(`<HashValue algorithm="SHA-256" encoding="Base64">${documentSha256Base64}</HashValue>`)
    expect(xml).toContain(
      '<EncryptedKey algorithm="RSA" mode="ECB" padding="PKCS#1">wrapped-key==</EncryptedKey>',
    )
    expect(xml).toContain(
      '<InitializationVector algorithm="AES" mode="CBC" encoding="Base64">initial-vector==</InitializationVector>',
    )
    expect(xml).toContain('<FilePart>')
    expect(xml).toContain(`<HashValue algorithm="MD5" encoding="Base64">${partMd5Base64}</HashValue>`)
    expect(xml).toContain('<FileName>jpk-part-1.bin</FileName>')
    expect(xml).toContain('<FileSize>14</FileSize>')
  })
})

describe('buildJpkAuthData', () => {
  it('emits the natural-person AuthData revenue element', () => {
    expect(buildJpkAuthData('1234.56')).toContain('<AuthData>')
    expect(buildJpkAuthData('1234.56')).toContain('<RevenueAmount>1234.56</RevenueAmount>')
  })
})
