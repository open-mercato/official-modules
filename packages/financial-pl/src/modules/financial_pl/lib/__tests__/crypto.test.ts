import {
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
  constants as cryptoConstants,
} from 'node:crypto'
import {
  aes256CbcEncrypt,
  encryptAuthToken,
  encryptInvoiceDocument,
  generateSymmetricKey,
  rsaOaepEncrypt,
  sha256Base64,
  wrapSymmetricKey,
  AES_KEY_BYTES,
  AES_IV_BYTES,
} from '../crypto'

function rsaPair() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const spkiBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  return { spkiBase64, privateKey }
}

function rsaOaepDecrypt(privateKey: ReturnType<typeof rsaPair>['privateKey'], ciphertext: Buffer): Buffer {
  return privateDecrypt(
    { key: privateKey, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    ciphertext,
  )
}

describe('financial_pl crypto', () => {
  it('round-trips AES-256-CBC encryption of the invoice document', () => {
    const material = generateSymmetricKey()
    expect(material.key.length).toBe(AES_KEY_BYTES)
    expect(material.iv.length).toBe(AES_IV_BYTES)

    const xml = '<Faktura>żółć &amp; test</Faktura>'
    const result = encryptInvoiceDocument(xml, material)

    const decipher = createDecipheriv('aes-256-cbc', material.key, material.iv)
    const plain = Buffer.concat([decipher.update(result.encryptedDocument), decipher.final()]).toString('utf8')
    expect(plain).toBe(xml)

    expect(result.invoiceSize).toBe(Buffer.byteLength(xml, 'utf8'))
    expect(result.invoiceHash).toBe(sha256Base64(Buffer.from(xml, 'utf8')))
    expect(result.encryptedDocumentHash).toBe(sha256Base64(result.encryptedDocument))
    expect(result.encryptedDocumentSize).toBe(result.encryptedDocument.length)
  })

  it('rejects a wrong-sized AES key', () => {
    expect(() => aes256CbcEncrypt(Buffer.from('x'), { key: Buffer.alloc(8), iv: Buffer.alloc(16) })).toThrow()
  })

  it('RSA-OAEP-SHA256 wraps the symmetric key recoverably', () => {
    const { spkiBase64, privateKey } = rsaPair()
    const material = generateSymmetricKey()
    const wrapped = wrapSymmetricKey(material, spkiBase64)
    const recovered = rsaOaepDecrypt(privateKey, Buffer.from(wrapped, 'base64'))
    expect(recovered.equals(material.key)).toBe(true)
  })

  it('encrypts the auth token as "{token}|{timestamp}"', () => {
    const { spkiBase64, privateKey } = rsaPair()
    const encrypted = encryptAuthToken('KSEF-TOKEN-123', 1750000000000, spkiBase64)
    const recovered = rsaOaepDecrypt(privateKey, Buffer.from(encrypted, 'base64')).toString('utf8')
    expect(recovered).toBe('KSEF-TOKEN-123|1750000000000')
  })

  it('produces a stable SHA-256 base64 hash', () => {
    expect(sha256Base64(Buffer.from('', 'utf8'))).toBe('47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=')
  })

  it('rsaOaepEncrypt accepts a KeyObject-less SPKI string', () => {
    const { spkiBase64, privateKey } = rsaPair()
    const ciphertext = rsaOaepEncrypt(Buffer.from('hello'), spkiBase64)
    expect(rsaOaepDecrypt(privateKey, ciphertext).toString('utf8')).toBe('hello')
  })
})
