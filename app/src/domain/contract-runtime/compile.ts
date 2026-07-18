import { z, type ZodType } from 'zod'
import type {
  CompiledContract,
  ContractField,
  ContractFieldType,
  ContractSource,
} from './types'

function primitiveSchema(
  type: Exclude<ContractFieldType, 'array' | 'object' | 'enum'>,
  description?: string,
): ZodType {
  let schema: ZodType
  switch (type) {
    case 'number':
      schema = z.number()
      break
    case 'boolean':
      schema = z.boolean()
      break
    case 'date':
      // ISO dátum (YYYY-MM-DD) vagy dátum-idő — a modell tipikusan stringet ad.
      schema = z.string().min(1).refine((v) => !Number.isNaN(Date.parse(v)), {
        message: 'Érvényes dátumot vártunk',
      })
      break
    case 'string':
    default:
      schema = z.string().min(1)
      break
  }
  return description ? schema.describe(description) : schema
}

function fieldToZod(field: ContractField): ZodType {
  let schema: ZodType
  switch (field.type) {
    case 'enum': {
      const values = field.enumValues?.length ? field.enumValues : ([''] as [string, ...string[]])
      schema = z.enum(values as [string, ...string[]])
      break
    }
    case 'array': {
      const item = primitiveSchema(field.itemType ?? 'string')
      schema = z.array(item)
      break
    }
    case 'object': {
      if (field.fields && field.fields.length > 0) {
        schema = fieldsToObjectSchema(field.fields)
      } else {
        schema = z.record(z.string(), z.unknown())
      }
      break
    }
    default:
      schema = primitiveSchema(field.type, field.description)
      break
  }
  if (field.description && field.type !== 'string' && field.type !== 'date') {
    schema = schema.describe(field.description)
  }
  if (field.required === false) {
    return schema.optional()
  }
  return schema
}

function fieldsToObjectSchema(fields: ContractField[]): ZodType<Record<string, unknown>> {
  const shape: Record<string, ZodType> = {}
  for (const field of fields) {
    shape[field.name] = fieldToZod(field)
  }
  return z.object(shape).strict() as ZodType<Record<string, unknown>>
}

/**
 * Tipizált mezőlista és/vagy legacy mezőnév-lista → futásidejű Zod-séma.
 * A régi mezőnév-lista szigorúan: kötelező, nem üres szöveg.
 */
export function compileContract(source: ContractSource): CompiledContract {
  const fromTyped = source.fields ?? []
  const typedNames = new Set(fromTyped.map((f) => f.name))
  const legacyFields: ContractField[] = (source.requiredFields ?? [])
    .filter((name) => !typedNames.has(name))
    .map((name) => ({ name, type: 'string' as const, required: true }))

  const fields = [...fromTyped, ...legacyFields]
  if (fields.length === 0) {
    return {
      fieldNames: [],
      fields: [],
      schema: z.object({}).passthrough() as ZodType<Record<string, unknown>>,
    }
  }

  return {
    fieldNames: fields.map((f) => f.name),
    fields,
    schema: fieldsToObjectSchema(fields),
  }
}

/**
 * Meglévő Zod-objektum-séma → CompiledContract (wiki, connector, skill review…).
 * A mezőneveket a Zod shape-ből olvassuk, ha a hívó nem adja meg.
 */
export function compileFromZod(
  schema: ZodType<Record<string, unknown>>,
  options?: { fieldNames?: string[]; fields?: ContractField[] },
): CompiledContract {
  const shapeNames =
    schema instanceof z.ZodObject ? Object.keys(schema.shape as Record<string, unknown>) : []
  const fields =
    options?.fields ??
    (options?.fieldNames ?? shapeNames).map((name) => ({
      name,
      type: 'string' as const,
      required: true,
    }))
  const fieldNames = options?.fieldNames ?? fields.map((f) => f.name)
  return { schema, fields, fieldNames }
}

/** Zod-séma → JSON Schema (provider-natív séma-kényszerhez). Hibánál `null`. */
export function contractToJsonSchema(
  contract: CompiledContract,
): Record<string, unknown> | null {
  try {
    // `io: 'input'` + `unrepresentable: 'any'`: a default/transform mezők (pl. connector
    // config) ne dobjanak — a provider kapjon használható sémát.
    return z.toJSONSchema(contract.schema, {
      io: 'input',
      unrepresentable: 'any',
    }) as Record<string, unknown>
  } catch {
    // Képesség hiánya nem hibaág — a hívó a prompt + közös beolvasóra esik vissza.
    return null
  }
}
