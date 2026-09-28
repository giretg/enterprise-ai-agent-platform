/** Loose translator for dynamic keys (error codes, nav keys). */
export type TranslateFn = (key: string, values?: Record<string, string | number | Date>) => string

export function asTranslate(t: (key: never, values?: never) => string): TranslateFn {
  return t as unknown as TranslateFn
}
