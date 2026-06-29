/**
 * KSeF 2.0 `AuthTokenRequest` XML builder (the document XAdES-signed for the
 * certificate / qualified-signature authentication path, `POST /auth/xades-signature`).
 *
 * The element name, namespace and child order are pinned to the authoritative
 * schema `https://api-test.ksef.mf.gov.pl/docs/v2/schemas/authv2.xsd`
 * (targetNamespace `http://ksef.mf.gov.pl/auth/token/2.0`, elementFormDefault
 * qualified):
 *   <AuthTokenRequest xmlns="http://ksef.mf.gov.pl/auth/token/2.0">
 *     <Challenge>{challenge}</Challenge>
 *     <ContextIdentifier><Nip>{nip}</Nip></ContextIdentifier>
 *     <SubjectIdentifierType>certificateSubject</SubjectIdentifierType>
 *   </AuthTokenRequest>
 *
 * Pure (string building only) so it is fully unit-testable and can be validated
 * against the official XSD with xmllint offline.
 */

export const KSEF_AUTH_TOKEN_NAMESPACE = 'http://ksef.mf.gov.pl/auth/token/2.0'

export type KsefSubjectIdentifierType = 'certificateSubject' | 'certificateFingerprint'

export type AuthTokenRequestInput = {
  /** The challenge string from `POST /auth/challenge` (format `\d{8}-CR-…`). */
  challenge: string
  /** The taxpayer NIP that owns the KSeF context. */
  contextNip: string
  /** How KSeF maps the XAdES signer cert to a subject. Default `certificateSubject`. */
  subjectIdentifierType?: KsefSubjectIdentifierType
}

// NIP per the schema TNIP pattern: 10 digits, first non-zero. We validate the
// 10-digit shape here (the full checksum is validated upstream at the data layer)
// so we never serialize an obviously malformed context identifier.
const NIP_SHAPE = /^[1-9]\d{9}$/

/**
 * Build the (unsigned) `AuthTokenRequest` XML. The string is deliberately
 * compact and namespace-qualified on the root so the enveloped XAdES signature
 * appended later canonicalizes deterministically.
 */
export function buildAuthTokenRequestXml(input: AuthTokenRequestInput): string {
  const nip = input.contextNip.trim()
  if (!NIP_SHAPE.test(nip)) {
    throw new Error('[internal] KSeF AuthTokenRequest requires a 10-digit context NIP')
  }
  const challenge = input.challenge.trim()
  if (!challenge) {
    throw new Error('[internal] KSeF AuthTokenRequest requires a challenge')
  }
  const subjectType: KsefSubjectIdentifierType = input.subjectIdentifierType ?? 'certificateSubject'
  return (
    `<AuthTokenRequest xmlns="${KSEF_AUTH_TOKEN_NAMESPACE}">` +
    `<Challenge>${challenge}</Challenge>` +
    `<ContextIdentifier><Nip>${nip}</Nip></ContextIdentifier>` +
    `<SubjectIdentifierType>${subjectType}</SubjectIdentifierType>` +
    `</AuthTokenRequest>`
  )
}
