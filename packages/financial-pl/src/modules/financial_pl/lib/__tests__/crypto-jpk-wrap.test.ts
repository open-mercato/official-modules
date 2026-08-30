import 'reflect-metadata'
import { constants as cryptoConstants, privateDecrypt, webcrypto } from 'node:crypto'
import * as x509 from '@peculiar/x509'
import { rsaPkcs1v15WrapKey } from '../crypto'

async function selfSignedRsaCert(): Promise<{ certificatePem: string; privateKeyPem: string }> {
  x509.cryptoProvider.set(webcrypto as unknown as Crypto)
  const alg = {
    name: 'RSASSA-PKCS1-v1_5',
    hash: 'SHA-256',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
  }
  const keys = (await webcrypto.subtle.generateKey(alg as never, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '015',
    name: 'CN=MF JPK Test, C=PL',
    notBefore: new Date('2026-01-01'),
    notAfter: new Date('2028-01-01'),
    keys,
    signingAlgorithm: alg,
  })
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey))
  const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${pkcs8
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .replace(/\n$/, '')}\n-----END PRIVATE KEY-----\n`
  return { certificatePem: cert.toString('pem'), privateKeyPem }
}

describe('rsaPkcs1v15WrapKey', () => {
  it('wraps a 32-byte AES key with an MF JPK certificate using RSA PKCS#1 v1.5', async () => {
    const { certificatePem, privateKeyPem } = await selfSignedRsaCert()
    const aesKey = Buffer.from(Array.from({ length: 32 }, (_value, index) => index + 1))

    const wrapped = rsaPkcs1v15WrapKey(aesKey, certificatePem)
    const recovered = privateDecrypt({ key: privateKeyPem, padding: cryptoConstants.RSA_PKCS1_PADDING }, wrapped)

    expect(wrapped.length).toBe(256)
    expect(recovered.equals(aesKey)).toBe(true)
  })
})
