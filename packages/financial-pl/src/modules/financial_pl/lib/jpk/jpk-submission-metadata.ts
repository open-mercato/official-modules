export type JpkUploadParts = { encryptedPart: Buffer; ordinalNumber: number; fileName: string }[]

export type BuildJpkMetadataInput = {
  jpkXml: string
  documentSha256Base64: string
  documentSize: number
  encryptedKeyBase64: string
  initializationVectorBase64: string
  parts: { ordinalNumber: number; fileName: string; partMd5Base64: string; partSize: number }[]
}

function escapeXml(value: string | number): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Build the MF JPK InitUpload metadata XML per spec v5.20: a <Document> with HashValue=SHA-256+Base64,
 *  FileSize, the AES key block (algorithm=RSA mode=ECB padding=PKCS#1 EncryptedKey + AES IV), and one
 *  <FilePart> per uploaded part (HashValue=MD5+Base64, FileName, FileSize). */
export function buildJpkInitUploadMetadata(input: BuildJpkMetadataInput): string {
  const fileParts = input.parts
    .map(
      (part) => `    <FilePart>
      <OrdinalNumber>${escapeXml(part.ordinalNumber)}</OrdinalNumber>
      <FileName>${escapeXml(part.fileName)}</FileName>
      <HashValue algorithm="MD5" encoding="Base64">${escapeXml(part.partMd5Base64)}</HashValue>
      <FileSize>${escapeXml(part.partSize)}</FileSize>
    </FilePart>`,
    )
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<InitUpload xmlns="http://e-dokumenty.mf.gov.pl">
  <Document>
    <HashValue algorithm="SHA-256" encoding="Base64">${escapeXml(input.documentSha256Base64)}</HashValue>
    <FileSize>${escapeXml(input.documentSize)}</FileSize>
    <Encryption>
      <EncryptedKey algorithm="RSA" mode="ECB" padding="PKCS#1">${escapeXml(input.encryptedKeyBase64)}</EncryptedKey>
      <InitializationVector algorithm="AES" mode="CBC" encoding="Base64">${escapeXml(input.initializationVectorBase64)}</InitializationVector>
    </Encryption>
    <FilePartList>
${fileParts}
    </FilePartList>
  </Document>
</InitUpload>`
}

export function buildJpkAuthData(revenueAmount: number | string): string {
  // [internal] not test-verifiable — prod natural-person path
  return `<?xml version="1.0" encoding="UTF-8"?>
<AuthData>
  <RevenueAmount>${escapeXml(revenueAmount)}</RevenueAmount>
</AuthData>`
}
