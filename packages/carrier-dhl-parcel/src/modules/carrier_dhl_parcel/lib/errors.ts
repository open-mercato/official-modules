// DHL Parcel Gateway API — https://api-gw.dhlparcel.nl/docs/combined.json

const throwError = (message: string): never => {
  throw new Error(message)
}

export const dhlErrors = {
  authFailed: () =>
    throwError('DHL authentication failed. Check credentials.'),
  apiError: (status: number, text: string) =>
    throwError(`DHL Parcel API error ${status}: ${text}`),
  cancellationNotSupported: () =>
    throwError('DHL Parcel does not support shipment cancellation via API.'),
  missingCredential: (field: string) =>
    throwError(`DHL Parcel credential "${field}" is required but was not provided.`),
  missingTrackingIdentifier: () =>
    throwError('trackingNumber or shipmentId is required for DHL Parcel tracking'),
  incompleteEnvPreset: () =>
    throwError(
      '[carrier_dhl_parcel] Incomplete DHL Parcel env preset. Set OM_INTEGRATION_DHL_PARCEL_USER_ID, OM_INTEGRATION_DHL_PARCEL_API_KEY, and OM_INTEGRATION_DHL_PARCEL_ACCOUNT_NUMBER.',
    ),
}
