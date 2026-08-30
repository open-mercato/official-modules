import { DOMParser } from '@xmldom/xmldom'

export type JpkUploadParts = { encryptedPart: Buffer; ordinalNumber: number; fileName: string }[]

export type BuildJpkMetadataInput = {
  jpkXml: string
  documentSha256Base64: string
  documentSize: number
  encryptedKeyBase64: string
  initializationVectorBase64: string
  parts: { ordinalNumber: number; fileName: string; partMd5Base64: string; partSize: number }[]
}

type JpkDocumentDescriptor = {
  formCode: string
  systemCode: string
  schemaVersion: string
  fileName: string
}

function escapeXml(value: string | number): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function requiredElementText(document: Document, name: string): string {
  const element = document.getElementsByTagName(name)[0]
  const value = element?.textContent?.trim()
  if (!value) throw new Error(`[internal] JPK XML is missing ${name}`)
  return value
}

export function resolveJpkDocumentDescriptor(jpkXml: string): JpkDocumentDescriptor {
  const document = new DOMParser().parseFromString(jpkXml, 'application/xml')
  const parserError = document.getElementsByTagName('parsererror')[0]
  if (parserError) throw new Error('[internal] JPK XML cannot be parsed')

  const formCodeElement = document.getElementsByTagName('KodFormularza')[0]
  const formCode = formCodeElement?.textContent?.trim()
  const systemCode = formCodeElement?.getAttribute('kodSystemowy')?.trim()
  const schemaVersion = formCodeElement?.getAttribute('wersjaSchemy')?.trim()
  if (!formCode || !systemCode || !schemaVersion) {
    throw new Error('[internal] JPK XML has incomplete KodFormularza metadata')
  }

  const year = requiredElementText(document, 'Rok')
  const month = requiredElementText(document, 'Miesiac').padStart(2, '0')
  const variant = systemCode.match(/^JPK_(V7M|V7K)\s*\(/)?.[1]
  if (!variant) throw new Error(`[internal] unsupported JPK system code: ${systemCode}`)

  return {
    formCode,
    systemCode,
    schemaVersion,
    fileName: `JPK_${variant}_${year}-${month}.xml`,
  }
}

/**
 * Build unsigned InitUpload metadata for the MF JPK REST gateway according to
 * the official InitUpload.xsd and interface specification 5.5.1.v22.
 */
export function buildJpkInitUploadMetadata(input: BuildJpkMetadataInput): string {
  const descriptor = resolveJpkDocumentDescriptor(input.jpkXml)
  const fileParts = input.parts
    .map(
      (part) => `        <FileSignature>
          <OrdinalNumber>${escapeXml(part.ordinalNumber)}</OrdinalNumber>
          <FileName>${escapeXml(part.fileName)}</FileName>
          <ContentLength>${escapeXml(part.partSize)}</ContentLength>
          <HashValue algorithm="MD5" encoding="Base64">${escapeXml(part.partMd5Base64)}</HashValue>
        </FileSignature>`,
    )
    .join('\n')

  return `<?xml version="1.0" encoding="utf-8"?>
<InitUpload xmlns="http://e-dokumenty.mf.gov.pl">
  <DocumentType>JPK</DocumentType>
  <Version>01.02.01.20160617</Version>
  <EncryptionKey algorithm="RSA" mode="ECB" padding="PKCS#1" encoding="Base64">${escapeXml(input.encryptedKeyBase64)}</EncryptionKey>
  <DocumentList>
    <Document>
      <FormCode systemCode="${escapeXml(descriptor.systemCode)}" schemaVersion="${escapeXml(descriptor.schemaVersion)}">${escapeXml(descriptor.formCode)}</FormCode>
      <FileName>${escapeXml(descriptor.fileName)}</FileName>
      <ContentLength>${escapeXml(input.documentSize)}</ContentLength>
      <HashValue algorithm="SHA-256" encoding="Base64">${escapeXml(input.documentSha256Base64)}</HashValue>
      <FileSignatureList filesNumber="${escapeXml(input.parts.length)}">
        <Packaging>
          <SplitZip type="split" mode="zip"/>
        </Packaging>
        <Encryption>
          <AES size="256" block="16" mode="CBC" padding="PKCS#7">
            <IV bytes="16" encoding="Base64">${escapeXml(input.initializationVectorBase64)}</IV>
          </AES>
        </Encryption>
${fileParts}
      </FileSignatureList>
    </Document>
  </DocumentList>
</InitUpload>`
}

export function buildJpkAuthData(revenueAmount: number | string): string {
  // [internal] not test-verifiable — prod natural-person path
  return `<?xml version="1.0" encoding="UTF-8"?>
<AuthData>
  <RevenueAmount>${escapeXml(revenueAmount)}</RevenueAmount>
</AuthData>`
}
