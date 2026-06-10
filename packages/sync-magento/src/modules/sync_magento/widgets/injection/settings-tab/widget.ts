import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import SyncMagentoSettingsWidget from './widget.client'

const widget: InjectionWidgetModule<{
  state?: { isEnabled?: boolean } | null
}, {
  hasCredentials?: boolean
}> = {
  metadata: {
    id: 'sync_magento.injection.settings',
    title: 'Magento Sync Settings',
    features: ['sync_magento.configure'],
    priority: 10,
  },
  Widget: SyncMagentoSettingsWidget,
}

export default widget
