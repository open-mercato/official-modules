/**
 * Triggers a browser download of a blob URL as a PDF file.
 *
 * @param url - Blob URL returned from URL.createObjectURL
 * @param filename - Base filename without extension
 */
export function downloadBlob(url: string, filename: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = `${filename}.pdf`
  a.click()
}
