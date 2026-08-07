import 'reflect-metadata'

import { webcrypto } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'

import * as x509 from '@peculiar/x509'

import { defaultZip, submitJpk } from '../jpk-submission-client'

const JPK_XML = `<?xml version="1.0" encoding="UTF-8"?>
<JPK xmlns="http://crd.gov.pl/wzor/2025/12/19/14090/">
  <Naglowek>
    <KodFormularza kodSystemowy="JPK_V7M (3)" wersjaSchemy="1-0E">JPK_VAT</KodFormularza>
    <Rok>2026</Rok>
    <Miesiac>7</Miesiac>
  </Naglowek>
</JPK>`

type TestCert = { certificatePem: string; privateKeyPem: string }

function pem(der: Buffer, label: string): string {
  return `-----BEGIN ${label}-----\n${der
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .replace(/\n$/, '')}\n-----END ${label}-----\n`
}

async function selfSignedCert(commonName: string): Promise<TestCert> {
  x509.cryptoProvider.set(webcrypto as unknown as Crypto)
  const alg = {
    name: 'RSASSA-PKCS1-v1_5',
    hash: 'SHA-256',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
  }
  const keys = (await webcrypto.subtle.generateKey(alg as never, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: `CN=${commonName}, 2.5.4.5=2481632647, C=PL`,
    notBefore: new Date('2026-01-01'),
    notAfter: new Date('2028-01-01'),
    keys,
    signingAlgorithm: alg,
  })
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey))
  return { certificatePem: cert.toString('pem'), privateKeyPem: pem(pkcs8, 'PRIVATE KEY') }
}

function responseJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('submitJpk', () => {
  it('creates the single-entry ZIP with the required DEFLATE compression method', () => {
    const zip = defaultZip(JPK_XML)
    const compressedSize = zip.readUInt32LE(18)
    const fileNameLength = zip.readUInt16LE(26)
    const dataStart = 30 + fileNameLength

    expect(zip.readUInt16LE(8)).toBe(8)
    expect(inflateRawSync(zip.subarray(dataStart, dataStart + compressedSize)).toString('utf8')).toBe(JPK_XML)
  })

  it('runs InitUpload, blob PUT, FinishUpload and Status to return the UPO', async () => {
    const signer = await selfSignedCert('JPK signer')
    const mf = await selfSignedCert('MF gateway')
    const calls: { url: string; method: string; body?: BodyInit | null; headers?: HeadersInit }[] = []
    const uploadUrl = 'https://blob.example.test/container/jpk-part-1?sig=abc'
    let uploadedBody: BodyInit | null | undefined

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method, body: init?.body, headers: init?.headers })

      if (url.endsWith('/api/Storage/InitUploadSigned')) {
        return responseJson({
          ReferenceNumber: 'JPK-REF-1',
          RequestToUploadFileList: [
            {
              BlobName: 'jpk-part-1',
              Url: uploadUrl,
              Method: 'PUT',
              HeaderList: [
                { Key: 'Content-MD5', Value: 'part-md5==' },
                { Key: 'x-ms-blob-type', Value: 'BlockBlob' },
              ],
            },
          ],
        })
      }
      if (url === uploadUrl) {
        uploadedBody = init?.body
        return new Response('', { status: 201 })
      }
      if (url.endsWith('/api/Storage/FinishUpload')) {
        return responseJson({})
      }
      if (url.endsWith('/api/Storage/Status/JPK-REF-1')) {
        return responseJson({ Status: '200', Upo: '<UPO>ok</UPO>' })
      }
      return responseJson({ message: 'not found' }, 404)
    }

    const result = await submitJpk(JPK_XML, {
      environment: 'test',
      signer,
      mfPublicCertPem: mf.certificatePem,
      fetchImpl,
      zip: (xml) => Buffer.from(`zipped:${xml}`),
    })

    expect(result).toEqual({ ok: true, referenceNumber: 'JPK-REF-1', status: '200', upoXml: '<UPO>ok</UPO>' })
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['POST', 'https://test-e-dokumenty.mf.gov.pl/api/Storage/InitUploadSigned'],
      ['PUT', uploadUrl],
      ['POST', 'https://test-e-dokumenty.mf.gov.pl/api/Storage/FinishUpload'],
      ['GET', 'https://test-e-dokumenty.mf.gov.pl/api/Storage/Status/JPK-REF-1'],
    ])
    expect(Buffer.isBuffer(uploadedBody)).toBe(true)
    expect((uploadedBody as Buffer).length).toBeGreaterThan(0)
    expect(calls[1].headers).toEqual({ 'Content-MD5': 'part-md5==', 'x-ms-blob-type': 'BlockBlob' })
    expect(JSON.parse(String(calls[2].body))).toEqual({
      ReferenceNumber: 'JPK-REF-1',
      AzureBlobNameList: ['jpk-part-1'],
    })
  })

  it('enables qualified-signature validation only when explicitly requested on TEST', async () => {
    const signer = await selfSignedCert('JPK signer')
    const mf = await selfSignedCert('MF gateway')
    const fetchImpl: typeof fetch = async (input) => {
      expect(String(input)).toBe(
        'https://test-e-dokumenty.mf.gov.pl/api/Storage/InitUploadSigned?enableValidateQualifiedSignature=true',
      )
      return responseJson({ Message: 'unknown trust provider', Code: 131 }, 400)
    }

    await expect(
      submitJpk(JPK_XML, {
        environment: 'test',
        signer,
        mfPublicCertPem: mf.certificatePem,
        validateQualifiedSignature: true,
        fetchImpl,
        zip: (xml) => Buffer.from(`zipped:${xml}`),
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'JPK InitUploadSigned failed with HTTP 400: 131 — unknown trust provider',
    })
  })

  it('returns ok false when Status is terminal failure', async () => {
    const signer = await selfSignedCert('JPK signer')
    const mf = await selfSignedCert('MF gateway')
    const uploadUrl = 'https://blob.example.test/container/jpk-part-1?sig=abc'

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/api/Storage/InitUploadSigned')) {
        return responseJson({
          ReferenceNumber: 'JPK-REF-2',
          RequestToUploadFileList: [
            { BlobName: 'jpk-part-1', Url: uploadUrl, HeaderList: [{ Key: 'x-ms-blob-type', Value: 'BlockBlob' }] },
          ],
        })
      }
      if (url === uploadUrl && init?.method === 'PUT') return new Response('', { status: 201 })
      if (url.endsWith('/api/Storage/FinishUpload')) return responseJson({})
      if (url.endsWith('/api/Storage/Status/JPK-REF-2')) {
        return responseJson({ Status: 'Rejected', Description: 'invalid JPK' })
      }
      return responseJson({}, 404)
    }

    const result = await submitJpk(JPK_XML, {
      environment: 'test',
      signer,
      mfPublicCertPem: mf.certificatePem,
      fetchImpl,
      zip: (xml) => Buffer.from(`zipped:${xml}`),
    })

    expect(result).toEqual({ ok: false, referenceNumber: 'JPK-REF-2', status: 'Rejected', error: 'invalid JPK' })
  })

  it('returns ok false instead of throwing when fetch throws', async () => {
    const signer = await selfSignedCert('JPK signer')
    const mf = await selfSignedCert('MF gateway')
    const fetchImpl: typeof fetch = async () => {
      throw new Error('network down')
    }

    await expect(
      submitJpk(JPK_XML, {
        environment: 'test',
        signer,
        mfPublicCertPem: mf.certificatePem,
        fetchImpl,
        zip: (xml) => Buffer.from(`zipped:${xml}`),
      }),
    ).resolves.toEqual({ ok: false, error: 'network down' })
  })
})
