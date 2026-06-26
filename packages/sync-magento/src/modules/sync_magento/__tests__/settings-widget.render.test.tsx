/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import Chance from 'chance'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import SyncMagentoSettingsWidget from '../widgets/injection/settings-tab/widget.client'

const chance = new Chance()

const mockApiCall = jest.fn()
const mockReadApiResultOrThrow = jest.fn()
const mockFlash = jest.fn()

const translate = (key: string, fallback?: string) => fallback ?? key
jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => translate,
}))

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: (...args: any[]) => mockApiCall(...args),
  readApiResultOrThrow: (...args: any[]) => mockReadApiResultOrThrow(...args),
}))

jest.mock('@open-mercato/ui/backend/FlashMessages', () => ({
  flash: (...args: any[]) => mockFlash(...args),
}))

jest.mock('@open-mercato/ui/backend/detail', () => ({
  LoadingMessage: ({ label }: { label?: string }) => <div data-testid="loading">{label}</div>,
  ErrorMessage: ({ label }: { label?: string }) => <div data-testid="error">{label}</div>,
}))

jest.mock('@open-mercato/ui/backend/CrudForm', () => ({
  CrudForm: ({ fields = [], groups = [], initialValues, onSubmit, submitLabel }: any) => {
    const [values, setValues] = React.useState(initialValues)
    const setValue = (name: string, value: unknown) => setValues((prev: any) => ({ ...prev, [name]: value }))
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit?.(values)
        }}
      >
        {fields.map((field: any) => (
          <div key={field.id} data-testid={`field-${field.id}`}>{field.label}</div>
        ))}
        {groups.map((group: any) => (
          <section key={group.id} data-testid={`group-${group.id}`}>
            <h3>{group.title}</h3>
            {group.component ? group.component({ values, setValue, errors: {} }) : null}
          </section>
        ))}
        <button type="submit">{submitLabel}</button>
      </form>
    )
  },
}))

const sampleSettings = (overrides: Record<string, unknown> = {}) => ({
  channelStockMappings: null,
  channelStoreMappings: null,
  orderImportStatuses: null,
  defaultOrderChannelId: null,
  customerStrategy: 'create_or_link' as const,
  attributeSetPrefix: 'om',
  attributeCodeOverrides: null,
  imageSyncEnabled: true,
  productExportConcurrency: 3,
  imageUploadConcurrency: 5,
  imageMaxDimension: 2000,
  updatedAt: new Date().toISOString(),
  ...overrides,
})

describe('SyncMagentoSettingsWidget', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockReadApiResultOrThrow.mockResolvedValue({ items: [] })
  })

  it('shows the loading state before settings resolve', async () => {
    let resolveSettings: (value: any) => void = () => {}
    mockApiCall.mockReturnValue(new Promise((resolve) => { resolveSettings = resolve }))

    render(<SyncMagentoSettingsWidget />)

    expect(screen.getByTestId('loading')).toBeInTheDocument()

    resolveSettings({ ok: true, result: sampleSettings() })
    await waitFor(() => expect(screen.queryByTestId('loading')).not.toBeInTheDocument())
  })

  it('shows an error state when loading settings fails', async () => {
    mockApiCall.mockResolvedValue({ ok: false, result: null })

    render(<SyncMagentoSettingsWidget />)

    await waitFor(() => expect(screen.getByTestId('error')).toBeInTheDocument())
    expect(screen.getByTestId('error')).toHaveTextContent('Failed to load Magento sync settings.')
  })

  it('renders the form groups including the custom mapping table groups once settings load', async () => {
    mockApiCall.mockResolvedValue({ ok: true, result: sampleSettings() })

    render(<SyncMagentoSettingsWidget />)

    await waitFor(() => expect(screen.getByTestId('group-general')).toBeInTheDocument())
    expect(screen.getByTestId('group-images')).toBeInTheDocument()
    expect(screen.getByTestId('group-channelStockMappings')).toBeInTheDocument()
    expect(screen.getByTestId('group-channelStoreMappings')).toBeInTheDocument()
    expect(screen.getByTestId('group-attributeCodeOverrides')).toBeInTheDocument()

    expect(screen.getByText('No channel → stock source mappings configured yet.')).toBeInTheDocument()
    expect(screen.getByText('No channel → store view mappings configured yet.')).toBeInTheDocument()
    expect(screen.getByText('No attribute code overrides configured yet.')).toBeInTheDocument()
  })

  it('shows only the inventory-relevant section on the magento_inventory integration page', async () => {
    mockApiCall.mockResolvedValue({ ok: true, result: sampleSettings() })

    render(<SyncMagentoSettingsWidget data={{ integration: { providerKey: 'magento_inventory' } }} />)

    await waitFor(() => expect(screen.getByTestId('group-channelStockMappings')).toBeInTheDocument())
    expect(screen.queryByTestId('group-general')).not.toBeInTheDocument()
    expect(screen.queryByTestId('group-images')).not.toBeInTheDocument()
    expect(screen.queryByTestId('group-channelStoreMappings')).not.toBeInTheDocument()
    expect(screen.queryByTestId('group-attributeCodeOverrides')).not.toBeInTheDocument()
  })

  it('shows only the order/customer and store-mapping sections on the magento_orders integration page', async () => {
    mockApiCall.mockResolvedValue({ ok: true, result: sampleSettings() })

    render(<SyncMagentoSettingsWidget data={{ integration: { providerKey: 'magento_orders' } }} />)

    await waitFor(() => expect(screen.getByTestId('group-general')).toBeInTheDocument())
    expect(screen.getByTestId('group-channelStoreMappings')).toBeInTheDocument()
    expect(screen.queryByTestId('group-images')).not.toBeInTheDocument()
    expect(screen.queryByTestId('group-channelStockMappings')).not.toBeInTheDocument()
    expect(screen.queryByTestId('group-attributeCodeOverrides')).not.toBeInTheDocument()
  })

  it('shows only the products-relevant sections on the magento_products integration page', async () => {
    mockApiCall.mockResolvedValue({ ok: true, result: sampleSettings() })

    render(<SyncMagentoSettingsWidget data={{ integration: { providerKey: 'magento_products' } }} />)

    await waitFor(() => expect(screen.getByTestId('group-images')).toBeInTheDocument())
    expect(screen.getByTestId('group-channelStoreMappings')).toBeInTheDocument()
    expect(screen.getByTestId('group-attributeCodeOverrides')).toBeInTheDocument()
    expect(screen.queryByTestId('group-general')).not.toBeInTheDocument()
    expect(screen.queryByTestId('group-channelStockMappings')).not.toBeInTheDocument()
  })

  it('shows only the store-mapping section on the magento_prices integration page', async () => {
    mockApiCall.mockResolvedValue({ ok: true, result: sampleSettings() })

    render(<SyncMagentoSettingsWidget data={{ integration: { providerKey: 'magento_prices' } }} />)

    await waitFor(() => expect(screen.getByTestId('group-channelStoreMappings')).toBeInTheDocument())
    expect(screen.queryByTestId('group-general')).not.toBeInTheDocument()
    expect(screen.queryByTestId('group-images')).not.toBeInTheDocument()
    expect(screen.queryByTestId('group-channelStockMappings')).not.toBeInTheDocument()
    expect(screen.queryByTestId('group-attributeCodeOverrides')).not.toBeInTheDocument()
  })

  it('adds a row to the channel→stock mapping table when "Add mapping" is clicked', async () => {
    mockApiCall.mockResolvedValue({ ok: true, result: sampleSettings() })

    render(<SyncMagentoSettingsWidget />)

    await waitFor(() => expect(screen.getByTestId('group-channelStockMappings')).toBeInTheDocument())

    const stockGroup = screen.getByTestId('group-channelStockMappings')
    fireEvent.click(within(stockGroup).getByRole('button', { name: 'Add mapping' }))

    expect(within(stockGroup).getByPlaceholderText('e.g. default')).toBeInTheDocument()
    expect(within(stockGroup).queryByText('No channel → stock source mappings configured yet.')).not.toBeInTheDocument()
  })

  it('submits the settings payload and shows a success flash message', async () => {
    const settings = sampleSettings()
    mockApiCall.mockResolvedValue({ ok: true, result: settings })
    mockReadApiResultOrThrow.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/sales/channels')) return { items: [] }
      return { ...settings, attributeSetPrefix: 'updated' }
    })

    render(<SyncMagentoSettingsWidget />)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save settings' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))

    await waitFor(() => expect(mockFlash).toHaveBeenCalledWith('Magento sync settings saved.', 'success'))

    const [url, init] = mockReadApiResultOrThrow.mock.calls.find(([callUrl]: [string]) => callUrl === '/api/sync-magento/settings') ?? []
    expect(url).toBe('/api/sync-magento/settings')
    expect(init.method).toBe('PUT')
    const payload = JSON.parse(init.body)
    expect(payload).not.toHaveProperty('updatedAt')
    expect(payload.attributeSetPrefix).toBe('om')
    expect(payload.customerStrategy).toBe('create_or_link')
  })
})
