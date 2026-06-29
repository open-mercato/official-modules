import { createModuleEvents } from '@open-mercato/shared/modules/events'

const events = [
  { id: 'financial_pl.ksef_submission.queued', label: 'KSeF Submission Queued', entity: 'ksef_submission', category: 'lifecycle' },
  { id: 'financial_pl.ksef_submission.repoll', label: 'KSeF Submission Re-poll', entity: 'ksef_submission', category: 'lifecycle' },
  { id: 'financial_pl.ksef_submission.send_offline', label: 'KSeF Offline Submission Send', entity: 'ksef_submission', category: 'lifecycle' },
  { id: 'financial_pl.ksef_submission.accepted', label: 'KSeF Submission Accepted', entity: 'ksef_submission', category: 'lifecycle', clientBroadcast: true },
  { id: 'financial_pl.ksef_submission.rejected', label: 'KSeF Submission Rejected', entity: 'ksef_submission', category: 'lifecycle', clientBroadcast: true },
] as const

export const eventsConfig = createModuleEvents({ moduleId: 'financial_pl', events })
export const emitFinancialPlEvent = eventsConfig.emit
export type FinancialPlEventId = typeof events[number]['id']
export default eventsConfig
