'use client'

/**
 * Közérthető tipizált kimeneti-contract szerkesztő (#44).
 * Nem JSON textarea — hétköznapi magyar címkék + típusonként példa.
 */
import { PlaybookFieldHint } from '@/components/playbooks/playbook-field-hint'
import {
  applySuggestedOutputFields,
  CONTRACT_FIELD_TYPE_OPTIONS,
  emptyOutputContractFormField,
  formFieldsToOutputContractJson,
  outputContractToFormFields,
  readOutputContractFormMeta,
  suggestedOutputFieldNames,
  tryParseOutputContractJson,
  type OutputContractFormField,
} from '@/lib/playbook-v2/output-contract-form'
import type { ContractFieldType } from '@/domain/contract-runtime/types'
import { HARD_MAX_REPAIR_ATTEMPTS } from '@/domain/contract-runtime/types'

const FIELD_CLASS = 'w-full rounded border border-ink/15 bg-transparent px-2 py-1 text-sm'
const LABEL_CLASS = 'text-ink-soft mb-0.5 block'
const ITEM_TYPES: Array<Exclude<ContractFieldType, 'array' | 'object' | 'enum'>> = [
  'string',
  'number',
  'boolean',
  'date',
]

function FieldRowEditor({
  field,
  onChange,
  onRemove,
  depth = 0,
}: {
  field: OutputContractFormField
  onChange: (next: OutputContractFormField) => void
  onRemove: () => void
  depth?: number
}) {
  const typeOption = CONTRACT_FIELD_TYPE_OPTIONS.find((o) => o.value === field.type)

  return (
    <div
      className={`space-y-1.5 rounded border border-ink/10 bg-paper/40 p-2 ${depth > 0 ? 'ml-2 border-dashed' : ''}`}
    >
      <div className="grid grid-cols-[1fr_1fr_auto_auto] items-end gap-1.5">
        <label className="block text-xs">
          <span className={LABEL_CLASS}>Mező neve</span>
          <input
            value={field.name}
            onChange={(e) => onChange({ ...field, name: e.target.value })}
            className={FIELD_CLASS}
            placeholder="pl. price"
          />
        </label>
        <label className="block text-xs">
          <span className={LABEL_CLASS}>Milyen adat ez?</span>
          <select
            value={field.type}
            onChange={(e) =>
              onChange({ ...field, type: e.target.value as ContractFieldType })
            }
            className={FIELD_CLASS}
          >
            {CONTRACT_FIELD_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 pb-1 text-xs text-ink-soft">
          <input
            type="checkbox"
            checked={field.required}
            onChange={(e) => onChange({ ...field, required: e.target.checked })}
          />
          Kötelező
        </label>
        <button
          type="button"
          onClick={onRemove}
          className="rounded border border-ink/15 px-1.5 py-1 text-xs text-ink-soft hover:bg-ink/5"
          title="Mező törlése"
        >
          ✕
        </button>
      </div>

      {typeOption && (
        <PlaybookFieldHint>
          {typeOption.label}: {typeOption.example}
        </PlaybookFieldHint>
      )}

      <label className="block text-xs">
        <span className={LABEL_CLASS}>Rövid magyarázat az agentnek</span>
        <input
          value={field.description}
          onChange={(e) => onChange({ ...field, description: e.target.value })}
          className={FIELD_CLASS}
          placeholder="Mit várunk ebben a mezőben?"
        />
      </label>

      {field.type === 'enum' && (
        <label className="block text-xs">
          <span className={LABEL_CLASS}>Választható értékek (vesszővel)</span>
          <input
            value={field.enumValuesText}
            onChange={(e) => onChange({ ...field, enumValuesText: e.target.value })}
            className={FIELD_CLASS}
            placeholder="jóváhagyva, elutasítva"
          />
          <PlaybookFieldHint>Csak ezek közül választhat az agent.</PlaybookFieldHint>
        </label>
      )}

      {field.type === 'array' && (
        <label className="block text-xs">
          <span className={LABEL_CLASS}>A lista elemei milyenek?</span>
          <select
            value={field.itemType}
            onChange={(e) =>
              onChange({
                ...field,
                itemType: e.target.value as OutputContractFormField['itemType'],
              })
            }
            className={FIELD_CLASS}
          >
            {ITEM_TYPES.map((t) => {
              const opt = CONTRACT_FIELD_TYPE_OPTIONS.find((o) => o.value === t)
              return (
                <option key={t} value={t}>
                  {opt?.label ?? t}
                </option>
              )
            })}
          </select>
        </label>
      )}

      {field.type === 'object' && depth < 2 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-ink-soft">Belső mezők</p>
          {field.nestedFields.map((nested, i) => (
            <FieldRowEditor
              key={i}
              field={nested}
              depth={depth + 1}
              onChange={(next) =>
                onChange({
                  ...field,
                  nestedFields: field.nestedFields.map((n, j) => (j === i ? next : n)),
                })
              }
              onRemove={() =>
                onChange({
                  ...field,
                  nestedFields: field.nestedFields.filter((_, j) => j !== i),
                })
              }
            />
          ))}
          <button
            type="button"
            onClick={() =>
              onChange({
                ...field,
                nestedFields: [...field.nestedFields, emptyOutputContractFormField()],
              })
            }
            className="rounded border border-ink/20 px-2 py-0.5 text-[11px] hover:bg-ink/5"
          >
            + belső mező
          </button>
        </div>
      )}

      {depth === 0 && (
        <details className="rounded border border-dashed border-ink/15 px-2 py-1.5">
          <summary className="cursor-pointer text-[11px] font-medium text-ink-soft">
            Tartalmi ellenőrzés (opcionális)
          </summary>
          <div className="mt-1.5 space-y-1.5">
            <PlaybookFieldHint>
              Csak ha bekapcsolod, fut bármi — különben nulla költség. Mintaillesztés ingyenes;
              „ítélet” egy rövid modellhívás a kapun át.
            </PlaybookFieldHint>
            <label className="block text-xs">
              <span className={LABEL_CLASS}>Milyen ellenőrzés?</span>
              <select
                value={field.contentCheckKind}
                onChange={(e) =>
                  onChange({
                    ...field,
                    contentCheckKind: e.target.value as OutputContractFormField['contentCheckKind'],
                  })
                }
                className={FIELD_CLASS}
              >
                <option value="none">Nincs</option>
                <option value="pattern">Minta (szabályos kifejezés)</option>
                <option value="judgment">Ítélet (modell dönt)</option>
              </select>
            </label>
            {field.contentCheckKind === 'pattern' && (
              <>
                <label className="block text-xs">
                  <span className={LABEL_CLASS}>Minta (pl. személyi szám formátum)</span>
                  <input
                    value={field.contentPattern}
                    onChange={(e) => onChange({ ...field, contentPattern: e.target.value })}
                    className={`${FIELD_CLASS} font-mono text-xs`}
                    placeholder={String.raw`\d{3}-\d{2}-\d{4}`}
                    spellCheck={false}
                  />
                </label>
                <label className="block text-xs">
                  <span className={LABEL_CLASS}>Elvárás</span>
                  <select
                    value={field.contentExpect}
                    onChange={(e) =>
                      onChange({
                        ...field,
                        contentExpect: e.target.value as 'match' | 'notMatch',
                      })
                    }
                    className={FIELD_CLASS}
                  >
                    <option value="notMatch">Ne illeszkedjen (tiltott minta)</option>
                    <option value="match">Illeszkedjen (kötelező minta)</option>
                  </select>
                </label>
              </>
            )}
            {field.contentCheckKind === 'judgment' && (
              <label className="block text-xs">
                <span className={LABEL_CLASS}>Mit döntsön el a modell?</span>
                <input
                  value={field.contentCriterion}
                  onChange={(e) => onChange({ ...field, contentCriterion: e.target.value })}
                  className={FIELD_CLASS}
                  placeholder="pl. Ne tartalmazzon személyes adatot"
                />
              </label>
            )}
            {field.contentCheckKind !== 'none' && (
              <label className="block text-xs">
                <span className={LABEL_CLASS}>Üzenet, ha nem felel meg (opcionális)</span>
                <input
                  value={field.contentMessage}
                  onChange={(e) => onChange({ ...field, contentMessage: e.target.value })}
                  className={FIELD_CLASS}
                  placeholder="Közérthető magyarázat a felülvizsgálónak"
                />
              </label>
            )}
          </div>
        </details>
      )}
    </div>
  )
}

export function OutputContractEditor({
  valueJson,
  onChangeJson,
  suggestedFieldNames,
}: {
  valueJson: string
  onChangeJson: (nextJson: string) => void
  /** Következő lépés kötelező input-réseiből származó javaslatok. */
  suggestedFieldNames?: string[]
}) {
  const parsed = tryParseOutputContractJson(valueJson)
  const parseError = valueJson.trim() !== '' && parsed == null
  const fields = parseError ? [] : outputContractToFormFields(parsed ?? undefined)
  const meta = parseError ? {} : readOutputContractFormMeta(parsed ?? undefined)
  const suggestions = suggestedOutputFieldNames(fields, suggestedFieldNames)

  function commit(nextFields: OutputContractFormField[], nextMeta = meta) {
    onChangeJson(formFieldsToOutputContractJson(nextFields, nextMeta))
  }

  return (
    <fieldset className="space-y-2 rounded border border-ink/10 p-2">
      <legend className="px-1 text-xs font-semibold text-ink-soft">
        Mit adjon át ez a lépés a következőnek?
      </legend>
      <PlaybookFieldHint>
        Írd le hétköznapi nyelven, milyen adatokat várunk a lépés végén. Nem kell sémát vagy JSON-t
        ismerned — a rendszer tipizált szerződést ment, és futáskor ellenőrzi.
      </PlaybookFieldHint>

      {parseError && (
        <div className="space-y-1.5 rounded border border-coral/40 bg-coral/10 px-2 py-1.5 text-[11px] text-coral">
          <p>
            A jelenlegi kimeneti szerződés sérült vagy nem olvasható. Töröld, és add hozzá újra a
            mezőket alább — nem kell JSON-t szerkesztened.
          </p>
          <button
            type="button"
            onClick={() => onChangeJson('')}
            className="rounded border border-coral/50 px-1.5 py-0.5 font-medium hover:bg-coral/15"
          >
            Szerződés törlése és újrakezdés
          </button>
        </div>
      )}

      {!parseError && suggestions.length > 0 && (
        <div className="rounded border border-accent/30 bg-accent/5 px-2 py-1.5 text-[11px]">
          <p className="mb-1 text-ink-soft">
            A következő lépés ezeket kéri — még nincsenek a szerződésben:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => commit(applySuggestedOutputFields(fields, [name]))}
                className="rounded border border-accent/40 bg-white/60 px-1.5 py-0.5 font-medium text-accent hover:bg-accent/10"
              >
                + {name}
              </button>
            ))}
            {suggestions.length > 1 && (
              <button
                type="button"
                onClick={() => commit(applySuggestedOutputFields(fields, suggestions))}
                className="rounded border border-ink/20 px-1.5 py-0.5 text-ink-soft hover:bg-ink/5"
              >
                Mindet hozzáadom
              </button>
            )}
          </div>
        </div>
      )}

      <div className="space-y-2">
        {fields.length === 0 && !parseError && (
          <p className="text-[11px] text-ink-faint">
            Még nincs mező — add hozzá, mit kell az agentnek visszaadnia.
          </p>
        )}
        {!parseError &&
          fields.map((field, i) => (
            <FieldRowEditor
              key={i}
              field={field}
              onChange={(next) => commit(fields.map((f, j) => (j === i ? next : f)))}
              onRemove={() => commit(fields.filter((_, j) => j !== i))}
            />
          ))}
      </div>

      {!parseError && (
        <button
          type="button"
          onClick={() => commit([...fields, emptyOutputContractFormField()])}
          className="rounded border border-ink/20 px-2 py-1 text-xs hover:bg-ink/5"
        >
          + mező hozzáadása
        </button>
      )}

      {!parseError && fields.length > 0 && (
        <label className="block text-xs">
          <span className={LABEL_CLASS}>
            Automatikus javítási próbák (0–{HARD_MAX_REPAIR_ATTEMPTS})
          </span>
          <select
            value={meta.maxRepairAttempts ?? ''}
            onChange={(e) => {
              const raw = e.target.value
              commit(
                fields,
                raw === ''
                  ? {}
                  : { maxRepairAttempts: Math.min(Number(raw), HARD_MAX_REPAIR_ATTEMPTS) },
              )
            }}
            className={FIELD_CLASS}
          >
            <option value="">Alapértelmezett (rendszer)</option>
            <option value="0">0 — azonnal emberhez (kritikus)</option>
            <option value="1">1 próba</option>
            <option value="2">2 próba (maximum)</option>
          </select>
          <PlaybookFieldHint>
            Ha az agent elrontja a formát, ennyiszer kérjük meg, hogy javítsa. Kritikus lépésnél
            érdemes 0.
          </PlaybookFieldHint>
        </label>
      )}
    </fieldset>
  )
}
