'use client'

import { FileText } from 'lucide-react'
import type { TemplateMeta } from '../lib/interfaces'

interface TemplateListItemProps {
  template: TemplateMeta
  onClick: (template: TemplateMeta) => void
}

export function TemplateListItem({ template, onClick }: TemplateListItemProps) {
  return (
    <button
      onClick={() => onClick(template)}
      className="flex items-start gap-4 rounded-lg border bg-card p-4 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
    >
      <div className="mt-0.5 rounded-md bg-muted p-2">
        <FileText className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="flex-1">
        <p className="text-sm font-semibold">{template.label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{template.description}</p>
      </div>
    </button>
  )
}
