"use client"

import * as React from 'react'
import { z } from 'zod'
import { Plus, Trash2 } from 'lucide-react'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { CrudForm, type CrudField, type CrudFieldOption, type CrudFormGroup } from '@open-mercato/ui/backend/CrudForm'
import { apiCall, readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Label } from '@open-mercato/ui/primitives/label'
import { useT } from '@open-mercato/shared/lib/i18n/context'

type ChannelStockMapping = { channelId: string; stockSource: string }
type ChannelStoreMapping = { channelId: string; storeViewCode: string; currencyCode: string }
type AttributeCodeOverride = { omFieldName: string; magentoAttributeCode: string }

type CustomerStrategy = 'create_or_link' | 'create_only' | 'skip'

type SettingsResponse = {
  channelStockMappings: ChannelStockMapping[] | null
  channelStoreMappings: ChannelStoreMapping[] | null
  orderImportStatuses: string[] | null
  defaultOrderChannelId: string | null
  customerStrategy: CustomerStrategy
  attributeSetPrefix: string
  attributeCodeOverrides: AttributeCodeOverride[] | null
  imageSyncEnabled: boolean
  productExportConcurrency: number
  imageUploadConcurrency: number
  imageMaxDimension: number
  updatedAt: string | null
}

type SettingsFormValues = {
  channelStockMappings: ChannelStockMapping[]
  channelStoreMappings: ChannelStoreMapping[]
  orderImportStatuses: string[]
  defaultOrderChannelId: string | null
  customerStrategy: CustomerStrategy
  attributeSetPrefix: string
  attributeCodeOverrides: AttributeCodeOverride[]
  imageSyncEnabled: boolean
  productExportConcurrency: number
  imageUploadConcurrency: number
  imageMaxDimension: number
  updatedAt?: string | null
}

function toFormValues(record: SettingsResponse | null): SettingsFormValues {
  return {
    channelStockMappings: record?.channelStockMappings ?? [],
    channelStoreMappings: record?.channelStoreMappings ?? [],
    orderImportStatuses: record?.orderImportStatuses ?? [],
    defaultOrderChannelId: record?.defaultOrderChannelId ?? null,
    customerStrategy: record?.customerStrategy ?? 'create_or_link',
    attributeSetPrefix: record?.attributeSetPrefix ?? 'om',
    attributeCodeOverrides: record?.attributeCodeOverrides ?? [],
    imageSyncEnabled: record?.imageSyncEnabled ?? true,
    productExportConcurrency: record?.productExportConcurrency ?? 3,
    imageUploadConcurrency: record?.imageUploadConcurrency ?? 5,
    imageMaxDimension: record?.imageMaxDimension ?? 2000,
    updatedAt: record?.updatedAt ?? null,
  }
}

type MappingColumn<TRow extends Record<string, string>> = {
  id: keyof TRow & string
  label: string
  kind: 'text' | 'select'
  placeholder?: string
  options?: CrudFieldOption[]
}

function MappingTable<TRow extends Record<string, string>>({
  rows,
  columns,
  onChange,
  createRow,
  addLabel,
  removeLabel,
  emptyLabel,
}: {
  rows: TRow[]
  columns: MappingColumn<TRow>[]
  onChange: (rows: TRow[]) => void
  createRow: () => TRow
  addLabel: string
  removeLabel: string
  emptyLabel: string
}) {
  const updateRow = React.useCallback((index: number, columnId: string, value: string) => {
    onChange(rows.map((row, idx) => (idx === index ? { ...row, [columnId]: value } : row)))
  }, [onChange, rows])

  const removeRow = React.useCallback((index: number) => {
    onChange(rows.filter((_, idx) => idx !== index))
  }, [onChange, rows])

  const addRow = React.useCallback(() => {
    onChange([...rows, createRow()])
  }, [createRow, onChange, rows])

  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        rows.map((row, index) => (
          <div key={index} className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3">
            {columns.map((column) => (
              <div key={column.id} className="min-w-40 flex-1 space-y-1">
                <Label className="text-xs uppercase text-muted-foreground">{column.label}</Label>
                {column.kind === 'select' ? (
                  <select
                    value={row[column.id] ?? ''}
                    onChange={(event) => updateRow(index, column.id, event.target.value)}
                    className="flex h-9 w-full items-center rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-colors focus-visible:border-foreground disabled:cursor-not-allowed disabled:bg-bg-disabled disabled:border-border-disabled"
                  >
                    <option value="">{column.placeholder}</option>
                    {(column.options ?? []).map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                ) : (
                  <Input
                    value={row[column.id] ?? ''}
                    placeholder={column.placeholder}
                    onChange={(event) => updateRow(index, column.id, event.target.value)}
                  />
                )}
              </div>
            ))}
            <IconButton type="button" variant="ghost" aria-label={removeLabel} onClick={() => removeRow(index)}>
              <Trash2 className="size-4" />
            </IconButton>
          </div>
        ))
      )}
      <Button type="button" variant="outline" size="sm" onClick={addRow}>
        <Plus className="size-4 mr-2" />
        {addLabel}
      </Button>
    </div>
  )
}

// Each Magento integration (products/prices/inventory/orders) shares one
// MagentoSyncSettings record and renders this widget at the same widget spot,
// but only the settings sections relevant to that integration's adapter are shown.
const PROVIDER_GROUP_VISIBILITY: Record<string, string[]> = {
  magento_products: ['images', 'channelStoreMappings', 'attributeCodeOverrides'],
  magento_prices: ['channelStoreMappings'],
  magento_inventory: ['channelStockMappings'],
  magento_orders: ['general', 'channelStoreMappings'],
}

export default function SyncMagentoSettingsWidget(
  props?: InjectionWidgetComponentProps<
    { state?: { isEnabled?: boolean } | null },
    { hasCredentials?: boolean; integration?: { providerKey?: string | null } }
  >,
) {
  const t = useT()
  const providerKey = props?.data?.integration?.providerKey ?? null
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [settings, setSettings] = React.useState<SettingsResponse | null>(null)
  const [formKey, setFormKey] = React.useState(0)
  const [channelOptions, setChannelOptions] = React.useState<CrudFieldOption[]>([])
  const formId = React.useId()

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const { ok, result } = await apiCall<SettingsResponse>('/api/sync-magento/settings')
        if (!ok || !result) throw new Error(t('sync_magento.settings.errors.load', 'Failed to load Magento sync settings.'))
        if (!cancelled) setSettings(result)
      } catch (err) {
        console.error('sync_magento.settings.load failed', err)
        if (!cancelled) setError(t('sync_magento.settings.errors.load', 'Failed to load Magento sync settings.'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [t])

  const loadChannelOptions = React.useCallback(async (query?: string): Promise<CrudFieldOption[]> => {
    try {
      const params = new URLSearchParams({ pageSize: '100', isActive: 'true' })
      if (query && query.trim().length) params.set('search', query.trim())
      const payload = await readApiResultOrThrow<{ items?: Array<{ id?: string; name?: string; code?: string }> }>(
        `/api/sales/channels?${params.toString()}`,
        undefined,
        { errorMessage: t('sync_magento.settings.errors.channelsLoad', 'Failed to load sales channels.') },
      )
      const items = Array.isArray(payload?.items) ? payload.items : []
      const options = items
        .map((entry) => {
          const value = typeof entry.id === 'string' ? entry.id : null
          if (!value) return null
          const label = typeof entry.name === 'string' && entry.name.trim().length ? entry.name : (entry.code ?? value)
          return { value, label }
        })
        .filter((entry): entry is CrudFieldOption => entry !== null)
      setChannelOptions((prev) => {
        const merged = new Map(prev.map((option) => [option.value, option]))
        for (const option of options) merged.set(option.value, option)
        return Array.from(merged.values())
      })
      return options
    } catch (err) {
      console.error('sync_magento.settings.channels.load failed', err)
      return []
    }
  }, [t])

  React.useEffect(() => {
    loadChannelOptions().catch(() => {})
  }, [loadChannelOptions])

  const channelLabel = React.useCallback((value: string) => channelOptions.find((option) => option.value === value)?.label ?? value, [channelOptions])

  const stockMappingColumns = React.useMemo<MappingColumn<ChannelStockMapping>[]>(() => [
    {
      id: 'channelId',
      label: t('sync_magento.settings.fields.channelStockMappings.columns.channel', 'Sales channel'),
      kind: 'select',
      options: channelOptions,
      placeholder: t('sync_magento.settings.fields.channelStockMappings.columns.channelPlaceholder', 'Select channel…'),
    },
    {
      id: 'stockSource',
      label: t('sync_magento.settings.fields.channelStockMappings.columns.stockSource', 'Magento stock source code'),
      kind: 'text',
      placeholder: t('sync_magento.settings.fields.channelStockMappings.columns.stockSourcePlaceholder', 'e.g. default'),
    },
  ], [channelOptions, t])

  const storeMappingColumns = React.useMemo<MappingColumn<ChannelStoreMapping>[]>(() => [
    {
      id: 'channelId',
      label: t('sync_magento.settings.fields.channelStoreMappings.columns.channel', 'Sales channel'),
      kind: 'select',
      options: channelOptions,
      placeholder: t('sync_magento.settings.fields.channelStoreMappings.columns.channelPlaceholder', 'Select channel…'),
    },
    {
      id: 'storeViewCode',
      label: t('sync_magento.settings.fields.channelStoreMappings.columns.storeView', 'Magento store view code'),
      kind: 'text',
      placeholder: t('sync_magento.settings.fields.channelStoreMappings.columns.storeViewPlaceholder', 'e.g. default'),
    },
    {
      id: 'currencyCode',
      label: t('sync_magento.settings.fields.channelStoreMappings.columns.currency', 'Currency code'),
      kind: 'text',
      placeholder: t('sync_magento.settings.fields.channelStoreMappings.columns.currencyPlaceholder', 'e.g. EUR'),
    },
  ], [channelOptions, t])

  const attributeOverrideColumns = React.useMemo<MappingColumn<AttributeCodeOverride>[]>(() => [
    {
      id: 'omFieldName',
      label: t('sync_magento.settings.fields.attributeCodeOverrides.columns.omField', 'Open Mercato field'),
      kind: 'text',
      placeholder: t('sync_magento.settings.fields.attributeCodeOverrides.columns.omFieldPlaceholder', 'e.g. season'),
    },
    {
      id: 'magentoAttributeCode',
      label: t('sync_magento.settings.fields.attributeCodeOverrides.columns.magentoCode', 'Magento attribute code'),
      kind: 'text',
      placeholder: t('sync_magento.settings.fields.attributeCodeOverrides.columns.magentoCodePlaceholder', 'e.g. om_season'),
    },
  ], [t])

  const customerStrategyOptions = React.useMemo<CrudFieldOption[]>(() => [
    { value: 'create_or_link', label: t('sync_magento.settings.fields.customerStrategy.options.createOrLink', 'Create or link existing customer') },
    { value: 'create_only', label: t('sync_magento.settings.fields.customerStrategy.options.createOnly', 'Always create a new customer') },
    { value: 'skip', label: t('sync_magento.settings.fields.customerStrategy.options.skip', 'Skip customer linking') },
  ], [t])

  const fields = React.useMemo<CrudField[]>(() => [
    {
      id: 'customerStrategy',
      label: t('sync_magento.settings.fields.customerStrategy.label', 'Customer matching strategy'),
      type: 'select',
      options: customerStrategyOptions,
      description: t('sync_magento.settings.fields.customerStrategy.description', 'How imported orders are linked to Open Mercato customers.'),
      layout: 'half',
    },
    {
      id: 'attributeSetPrefix',
      label: t('sync_magento.settings.fields.attributeSetPrefix.label', 'Attribute set / code prefix'),
      type: 'text',
      placeholder: 'om',
      maxLength: 32,
      description: t('sync_magento.settings.fields.attributeSetPrefix.description', 'Prefix applied to generated Magento attribute sets and codes. Leave empty to use native attribute names (risk of collisions).'),
      layout: 'half',
    },
    {
      id: 'defaultOrderChannelId',
      label: t('sync_magento.settings.fields.defaultOrderChannelId.label', 'Default sales channel for imported orders'),
      type: 'combobox',
      loadOptions: loadChannelOptions,
      seedOptions: channelOptions,
      resolveLabel: (value: string) => channelLabel(value),
      placeholder: t('sync_magento.settings.fields.defaultOrderChannelId.placeholder', 'Select channel…'),
      description: t('sync_magento.settings.fields.defaultOrderChannelId.description', 'Sales channel assigned to orders imported from Magento.'),
      layout: 'half',
    },
    {
      id: 'orderImportStatuses',
      label: t('sync_magento.settings.fields.orderImportStatuses.label', 'Magento order statuses to import'),
      type: 'tags',
      placeholder: t('sync_magento.settings.fields.orderImportStatuses.placeholder', 'e.g. processing'),
      description: t('sync_magento.settings.fields.orderImportStatuses.description', 'Only orders with these Magento statuses are imported. Leave empty to import all statuses.'),
      layout: 'half',
    },
    {
      id: 'imageSyncEnabled',
      label: t('sync_magento.settings.fields.imageSyncEnabled.label', 'Sync product images'),
      type: 'checkbox',
      description: t('sync_magento.settings.fields.imageSyncEnabled.description', 'Upload Open Mercato product images to Magento during product export.'),
      layout: 'half',
    },
    {
      id: 'productExportConcurrency',
      label: t('sync_magento.settings.fields.productExportConcurrency.label', 'Product export concurrency'),
      type: 'number',
      description: t('sync_magento.settings.fields.productExportConcurrency.description', 'Number of products exported in parallel (1-10).'),
      layout: 'third',
    },
    {
      id: 'imageUploadConcurrency',
      label: t('sync_magento.settings.fields.imageUploadConcurrency.label', 'Image upload concurrency'),
      type: 'number',
      description: t('sync_magento.settings.fields.imageUploadConcurrency.description', 'Number of images uploaded in parallel (1-10).'),
      layout: 'third',
    },
    {
      id: 'imageMaxDimension',
      label: t('sync_magento.settings.fields.imageMaxDimension.label', 'Max image dimension (px)'),
      type: 'number',
      description: t('sync_magento.settings.fields.imageMaxDimension.description', 'Images larger than this are resized before upload (0 disables resizing).'),
      layout: 'third',
    },
  ], [channelLabel, channelOptions, customerStrategyOptions, loadChannelOptions, t])

  const groups = React.useMemo<CrudFormGroup[]>(() => [
    {
      id: 'general',
      title: t('sync_magento.settings.sections.general.title', 'Order & customer sync'),
      description: t('sync_magento.settings.sections.general.description', 'Controls how orders and customers are imported from Magento.'),
      fields: ['customerStrategy', 'defaultOrderChannelId', 'orderImportStatuses'],
    },
    {
      id: 'images',
      title: t('sync_magento.settings.sections.images.title', 'Export performance & images'),
      description: t('sync_magento.settings.sections.images.description', 'Controls export throughput and product image handling.'),
      fields: ['imageSyncEnabled', 'productExportConcurrency', 'imageUploadConcurrency', 'imageMaxDimension'],
    },
    {
      id: 'channelStockMappings',
      title: t('sync_magento.settings.sections.channelStockMappings.title', 'Channel → stock source mapping'),
      description: t('sync_magento.settings.sections.channelStockMappings.description', 'Maps Open Mercato sales channels to Magento MSI stock sources for inventory sync.'),
      component: ({ values, setValue }) => (
        <MappingTable<ChannelStockMapping>
          rows={(values.channelStockMappings as ChannelStockMapping[] | undefined) ?? []}
          columns={stockMappingColumns}
          onChange={(rows) => setValue('channelStockMappings', rows)}
          createRow={() => ({ channelId: '', stockSource: '' })}
          addLabel={t('sync_magento.settings.fields.channelStockMappings.add', 'Add mapping')}
          removeLabel={t('sync_magento.settings.fields.channelStockMappings.remove', 'Remove mapping')}
          emptyLabel={t('sync_magento.settings.fields.channelStockMappings.empty', 'No channel → stock source mappings configured yet.')}
        />
      ),
    },
    {
      id: 'channelStoreMappings',
      title: t('sync_magento.settings.sections.channelStoreMappings.title', 'Channel → store view mapping'),
      description: t('sync_magento.settings.sections.channelStoreMappings.description', 'Maps Open Mercato sales channels to Magento store views and currencies for price/catalog sync.'),
      component: ({ values, setValue }) => (
        <MappingTable<ChannelStoreMapping>
          rows={(values.channelStoreMappings as ChannelStoreMapping[] | undefined) ?? []}
          columns={storeMappingColumns}
          onChange={(rows) => setValue('channelStoreMappings', rows)}
          createRow={() => ({ channelId: '', storeViewCode: '', currencyCode: '' })}
          addLabel={t('sync_magento.settings.fields.channelStoreMappings.add', 'Add mapping')}
          removeLabel={t('sync_magento.settings.fields.channelStoreMappings.remove', 'Remove mapping')}
          emptyLabel={t('sync_magento.settings.fields.channelStoreMappings.empty', 'No channel → store view mappings configured yet.')}
        />
      ),
    },
    {
      id: 'attributeCodeOverrides',
      title: t('sync_magento.settings.sections.attributeCodeOverrides.title', 'Attribute provisioning'),
      description: t('sync_magento.settings.sections.attributeCodeOverrides.description', 'Controls how Open Mercato custom fields are provisioned as Magento attributes, including the naming prefix and per-field code overrides.'),
      fields: ['attributeSetPrefix'],
      component: ({ values, setValue }) => (
        <MappingTable<AttributeCodeOverride>
          rows={(values.attributeCodeOverrides as AttributeCodeOverride[] | undefined) ?? []}
          columns={attributeOverrideColumns}
          onChange={(rows) => setValue('attributeCodeOverrides', rows)}
          createRow={() => ({ omFieldName: '', magentoAttributeCode: '' })}
          addLabel={t('sync_magento.settings.fields.attributeCodeOverrides.add', 'Add override')}
          removeLabel={t('sync_magento.settings.fields.attributeCodeOverrides.remove', 'Remove override')}
          emptyLabel={t('sync_magento.settings.fields.attributeCodeOverrides.empty', 'No attribute code overrides configured yet.')}
        />
      ),
    },
  ], [attributeOverrideColumns, stockMappingColumns, storeMappingColumns, t])

  const visibleGroups = React.useMemo(() => {
    const allowedGroupIds = providerKey ? PROVIDER_GROUP_VISIBILITY[providerKey] : null
    if (!allowedGroupIds) return groups
    return groups.filter((group) => allowedGroupIds.includes(group.id))
  }, [groups, providerKey])

  const schema = React.useMemo(() => z.object({
    channelStockMappings: z.array(z.object({
      channelId: z.string().uuid({ message: 'sync_magento.settings.errors.channelRequired' }),
      stockSource: z.string().trim().min(1, { message: 'sync_magento.settings.errors.stockSourceRequired' }).max(255),
    })),
    channelStoreMappings: z.array(z.object({
      channelId: z.string().uuid({ message: 'sync_magento.settings.errors.channelRequired' }),
      storeViewCode: z.string().trim().min(1, { message: 'sync_magento.settings.errors.storeViewCodeRequired' }).max(255),
      currencyCode: z.string().trim().length(3, { message: 'sync_magento.settings.errors.currencyCodeLength' }),
    })),
    orderImportStatuses: z.array(z.string().trim().min(1)),
    defaultOrderChannelId: z.string().uuid().nullable(),
    customerStrategy: z.enum(['create_or_link', 'create_only', 'skip']),
    attributeSetPrefix: z.string().trim().max(32),
    attributeCodeOverrides: z.array(z.object({
      omFieldName: z.string().trim().min(1, { message: 'sync_magento.settings.errors.omFieldNameRequired' }),
      magentoAttributeCode: z.string().trim().min(1).max(60)
        .regex(/^[a-z][a-z0-9_]*$/, { message: 'sync_magento.settings.errors.attributeCodeFormat' }),
    })),
    imageSyncEnabled: z.boolean(),
    productExportConcurrency: z.number().int().min(1).max(10),
    imageUploadConcurrency: z.number().int().min(1).max(10),
    imageMaxDimension: z.number().int().min(0).max(10000),
    updatedAt: z.string().nullable().optional(),
  }), [])

  const handleSubmit = React.useCallback(async (values: SettingsFormValues) => {
    const payload = {
      channelStockMappings: values.channelStockMappings,
      channelStoreMappings: values.channelStoreMappings,
      orderImportStatuses: values.orderImportStatuses,
      defaultOrderChannelId: values.defaultOrderChannelId,
      customerStrategy: values.customerStrategy,
      attributeSetPrefix: values.attributeSetPrefix,
      attributeCodeOverrides: values.attributeCodeOverrides,
      imageSyncEnabled: values.imageSyncEnabled,
      productExportConcurrency: values.productExportConcurrency,
      imageUploadConcurrency: values.imageUploadConcurrency,
      imageMaxDimension: values.imageMaxDimension,
    }

    const result = await readApiResultOrThrow<SettingsResponse>(
      '/api/sync-magento/settings',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
      { errorMessage: t('sync_magento.settings.errors.save', 'Failed to save Magento sync settings.') },
    )

    setSettings(result)
    setFormKey((prev) => prev + 1)
    flash(t('sync_magento.settings.success.saved', 'Magento sync settings saved.'), 'success')
  }, [t])

  if (loading) {
    return <LoadingMessage label={t('sync_magento.settings.loading', 'Loading Magento sync settings…')} />
  }
  if (error) {
    return <ErrorMessage label={error} />
  }

  return (
    <CrudForm<SettingsFormValues>
      key={formKey}
      formId={formId}
      schema={schema}
      fields={fields}
      groups={visibleGroups}
      initialValues={toFormValues(settings)}
      submitLabel={t('sync_magento.settings.save', 'Save settings')}
      onSubmit={handleSubmit}
      embedded
      twoColumn
    />
  )
}
