'use client'

interface PreviewProps {
  url: string
}

export function Preview({ url }: PreviewProps) {
  return <object data={url} type="application/pdf" width="100%" height="100%" />
}
