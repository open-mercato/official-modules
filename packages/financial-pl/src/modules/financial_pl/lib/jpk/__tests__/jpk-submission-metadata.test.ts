import { createHash } from 'node:crypto'

import {
  buildJpkAuthData,
  buildJpkInitUploadMetadata,
  resolveJpkDocumentDescriptor,
} from '../jpk-submission-metadata'

const jpkXml = `<?xml version="1.0" encoding="UTF-8"?>
<JPK xmlns="http://crd.gov.pl/wzor/2025/12/19/14090/">
  <Naglowek>
    <KodFormularza kodSystemowy="JPK_V7M (3)" wersjaSchemy="1-0E">JPK_VAT</KodFormularza>
    <Rok>2026</Rok>
    <Miesiac>7</Miesiac>
  </Naglowek>
</JPK>`

describe('buildJpkInitUploadMetadata', () => {
  it('emits document SHA-256, RSA key block, IV and per-part MD5 metadata', () => {
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

    expect(xml).toContain('<DocumentType>JPK</DocumentType>')
    expect(xml).toContain('<Version>01.02.01.20160617</Version>')
    expect(xml).toContain('<Document>')
    expect(xml).toContain('<FormCode systemCode="JPK_V7M (3)" schemaVersion="1-0E">JPK_VAT</FormCode>')
    expect(xml).toContain('<FileName>JPK_V7M_2026-07.xml</FileName>')
    expect(xml).toContain(`<ContentLength>${Buffer.byteLength(jpkXml, 'utf8')}</ContentLength>`)
    expect(xml).toContain(`<HashValue algorithm="SHA-256" encoding="Base64">${documentSha256Base64}</HashValue>`)
    expect(xml).toContain(
      '<EncryptionKey algorithm="RSA" mode="ECB" padding="PKCS#1" encoding="Base64">wrapped-key==</EncryptionKey>',
    )
    expect(xml).toContain(
      '<AES size="256" block="16" mode="CBC" padding="PKCS#7">',
    )
    expect(xml).toContain('<IV bytes="16" encoding="Base64">initial-vector==</IV>')
    expect(xml).toContain('<FileSignatureList filesNumber="1">')
    expect(xml).toContain('<SplitZip type="split" mode="zip"/>')
    expect(xml).toContain('<FileSignature>')
    expect(xml).toContain(`<HashValue algorithm="MD5" encoding="Base64">${partMd5Base64}</HashValue>`)
    expect(xml).toContain('<FileName>jpk-part-1.bin</FileName>')
    expect(xml).toContain('<ContentLength>14</ContentLength>')
    expect(xml).not.toContain('<EncryptedKey')
    expect(xml).not.toContain('<InitializationVector')
    expect(xml).not.toContain('<FilePart>')
    expect(xml).not.toContain('<FileSize>')
  })

  it('derives the form metadata and stable document name from the generated JPK header', () => {
    expect(resolveJpkDocumentDescriptor(jpkXml)).toEqual({
      formCode: 'JPK_VAT',
      systemCode: 'JPK_V7M (3)',
      schemaVersion: '1-0E',
      fileName: 'JPK_V7M_2026-07.xml',
    })
  })
})

describe('buildJpkAuthData', () => {
  it('emits the natural-person AuthData revenue element', () => {
    expect(buildJpkAuthData('1234.56')).toContain('<AuthData>')
    expect(buildJpkAuthData('1234.56')).toContain('<RevenueAmount>1234.56</RevenueAmount>')
  })
})
