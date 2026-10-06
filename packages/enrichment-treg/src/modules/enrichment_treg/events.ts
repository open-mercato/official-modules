import { createModuleEvents } from '@open-mercato/shared/modules/events'

const events = [
  { id: 'enrichment_treg.record.completed', label: 'Enrichment Completed', entity: 'record', category: 'lifecycle' as const, clientBroadcast: true },
  { id: 'enrichment_treg.record.failed', label: 'Enrichment Failed', entity: 'record', category: 'lifecycle' as const, clientBroadcast: true },
  { id: 'enrichment_treg.record.applied', label: 'Enrichment Applied', entity: 'record', category: 'lifecycle' as const },
  { id: 'enrichment_treg.signal.detected', label: 'Company Signals Detected', entity: 'signal', category: 'lifecycle' as const, clientBroadcast: true },
] as const

export const eventsConfig = createModuleEvents({ moduleId: 'enrichment_treg', events })
export const emitEnrichmentTregEvent = eventsConfig.emit
export type EnrichmentTregEventId = (typeof events)[number]['id']
export default eventsConfig
