import { FileEditorError } from '../workspace-storage'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function importMammoth(): Promise<any> {
  try {
    return await import('mammoth')
  } catch {
    throw new FileEditorError(
      'BINARY_ADAPTER_UNAVAILABLE',
      'mammoth is not installed. Run: npm install mammoth',
    )
  }
}

export async function docxRead(buffer: Buffer): Promise<{ text: string; messages: string[] }> {
  const mammoth = await importMammoth()
  const result = await mammoth.extractRawText({ buffer })
  return {
    text: result.value as string,
    messages: ((result.messages ?? []) as Array<{ message: string }>).map((m) => m.message),
  }
}
