/**
 * Output contract form helpers (#44) — tiszta függvények.
 *
 * Varrat: form ↔ tipizált tárolási alak (#37), javaslat a következő lépés igényeiből.
 * Nem teszteljük a React szerkesztő DOM-ját.
 *
 * Futtatás: npm run test:output-contract-form
 */
import assert from 'node:assert/strict'
import {
  applySuggestedOutputFields,
  emptyOutputContractFormField,
  ensureFieldInOutputContractJson,
  formFieldsToOutputContract,
  outputContractHasField,
  outputContractToFormFields,
  suggestedOutputFieldNames,
  type OutputContractFormField,
} from '../src/lib/playbook-v2/output-contract-form'
import { compileContract, validateAgainstContract } from '../src/domain/contract-runtime'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (e: unknown) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

function main() {
  console.log('=== Output contract form (#44) ===\n')

  check('OC-1a: üres contract → üres form', () => {
    assert.deepEqual(outputContractToFormFields(undefined), [])
    assert.deepEqual(outputContractToFormFields({}), [])
  })

  check('OC-1b: tipizált fields → form → ugyanaz a tárolási alak', () => {
    const stored = {
      fields: [
        {
          name: 'price',
          type: 'number',
          required: true,
          description: 'Nettó ár',
        },
        {
          name: 'decision',
          type: 'enum',
          required: true,
          enumValues: ['approve', 'reject'],
          description: 'Döntés',
        },
      ],
      maxRepairAttempts: 1,
    }
    const form = outputContractToFormFields(stored)
    assert.equal(form.length, 2)
    assert.equal(form[0]?.name, 'price')
    assert.equal(form[0]?.type, 'number')
    assert.equal(form[0]?.required, true)
    assert.equal(form[1]?.type, 'enum')
    assert.equal(form[1]?.enumValuesText, 'approve, reject')

    const roundTrip = formFieldsToOutputContract(form, { maxRepairAttempts: 1 })
    assert.deepEqual(roundTrip, {
      fields: [
        {
          name: 'price',
          type: 'number',
          required: true,
          description: 'Nettó ár',
        },
        {
          name: 'decision',
          type: 'enum',
          required: true,
          description: 'Döntés',
          enumValues: ['approve', 'reject'],
        },
      ],
      maxRepairAttempts: 1,
    })
  })

  check('OC-1c: legacy requiredFields → kötelező szövegmezők a formban', () => {
    const form = outputContractToFormFields({ requiredFields: ['vendor', 'deadline'] })
    assert.equal(form.length, 2)
    assert.deepEqual(
      form.map((f) => ({ name: f.name, type: f.type, required: f.required })),
      [
        { name: 'vendor', type: 'string', required: true },
        { name: 'deadline', type: 'string', required: true },
      ],
    )
    const stored = formFieldsToOutputContract(form)
    assert.ok(stored)
    assert.ok(Array.isArray(stored.fields))
    assert.equal((stored.fields as unknown[]).length, 2)
    assert.equal(stored.requiredFields, undefined)
  })

  check('OC-1d: lista + összetett mező round-trip', () => {
    const form: OutputContractFormField[] = [
      emptyOutputContractFormField({
        name: 'items',
        type: 'array',
        required: true,
        description: 'Tételek',
        itemType: 'string',
      }),
      emptyOutputContractFormField({
        name: 'supplier',
        type: 'object',
        required: true,
        description: 'Szállító',
        nestedFields: [
          emptyOutputContractFormField({
            name: 'name',
            type: 'string',
            required: true,
            description: 'Név',
          }),
        ],
      }),
    ]
    const stored = formFieldsToOutputContract(form)
    assert.deepEqual(stored?.fields, [
      {
        name: 'items',
        type: 'array',
        required: true,
        description: 'Tételek',
        itemType: 'string',
      },
      {
        name: 'supplier',
        type: 'object',
        required: true,
        description: 'Szállító',
        fields: [{ name: 'name', type: 'string', required: true, description: 'Név' }],
      },
    ])
    const back = outputContractToFormFields(stored)
    assert.equal(back[1]?.nestedFields[0]?.name, 'name')
  })

  check('OC-1e: mentett alak compile+validate-dal működik', () => {
    const stored = formFieldsToOutputContract([
      emptyOutputContractFormField({ name: 'price', type: 'number', required: true }),
    ])
    const contract = compileContract(stored!)
    const ok = validateAgainstContract(contract, { price: 1200 })
    assert.equal(ok.ok, true)
    const bad = validateAgainstContract(contract, { price: '' })
    assert.equal(bad.ok, false)
  })

  check('OC-2a: javaslat csak a még hiányzó mezőneveket adja', () => {
    const form = outputContractToFormFields({
      fields: [{ name: 'price', type: 'number', required: true }],
    })
    assert.deepEqual(suggestedOutputFieldNames(form, ['price', 'vendor', 'deadline']), [
      'vendor',
      'deadline',
    ])
  })

  check('OC-2b: javaslat alkalmazása kötelező szövegmezőket ad hozzá', () => {
    const form = outputContractToFormFields({
      fields: [{ name: 'price', type: 'number', required: true }],
    })
    const next = applySuggestedOutputFields(form, ['vendor'])
    assert.equal(next.length, 2)
    assert.equal(next[1]?.name, 'vendor')
    assert.equal(next[1]?.type, 'string')
    assert.equal(next[1]?.required, true)
  })

  check('OC-3a: outputContractHasField tipizált és legacy mezőn is', () => {
    assert.equal(
      outputContractHasField(
        { fields: [{ name: 'decision', type: 'string', required: true }] },
        'decision',
      ),
      true,
    )
    assert.equal(outputContractHasField({ requiredFields: ['decision'] }, 'decision'), true)
    assert.equal(outputContractHasField({ fields: [] }, 'decision'), false)
  })

  check('OC-3b: ensureFieldInOutputContractJson tipizált fields-be ír', () => {
    const json = ensureFieldInOutputContractJson('', 'decision')
    const parsed = JSON.parse(json) as { fields: Array<{ name: string; type: string }> }
    assert.ok(parsed.fields.some((f) => f.name === 'decision' && f.type === 'string'))
    assert.equal(outputContractHasField(parsed, 'decision'), true)

    const again = ensureFieldInOutputContractJson(json, 'decision')
    assert.equal(again, json)
  })

  check('OC-4a: contentCheck pattern round-trip + validáció (#45)', () => {
    const form: OutputContractFormField[] = [
      emptyOutputContractFormField({
        name: 'note',
        type: 'string',
        required: true,
        contentCheckKind: 'pattern',
        contentPattern: String.raw`\d{3}-\d{2}-\d{4}`,
        contentExpect: 'notMatch',
        contentMessage: 'Ne tartalmazzon személyi számot.',
      }),
    ]
    const stored = formFieldsToOutputContract(form)
    assert.deepEqual(stored, {
      fields: [
        {
          name: 'note',
          type: 'string',
          required: true,
          contentCheck: {
            kind: 'pattern',
            regex: String.raw`\d{3}-\d{2}-\d{4}`,
            expect: 'notMatch',
            message: 'Ne tartalmazzon személyi számot.',
          },
        },
      ],
    })
    const back = outputContractToFormFields(stored)
    assert.equal(back[0]?.contentCheckKind, 'pattern')
    assert.equal(back[0]?.contentExpect, 'notMatch')

    const contract = compileContract({ fields: stored!.fields as never })
    assert.equal(validateAgainstContract(contract, { note: 'ok' }).ok, true)
    assert.equal(validateAgainstContract(contract, { note: '123-45-6789' }).ok, false)
  })

  check('OC-4b: contentCheckKind none → nincs contentCheck a tárolásban', () => {
    const form: OutputContractFormField[] = [
      emptyOutputContractFormField({
        name: 'note',
        type: 'string',
        required: true,
        contentCheckKind: 'none',
        contentPattern: 'ignored',
        contentExpect: 'match',
        contentCriterion: 'ignored',
      }),
    ]
    const stored = formFieldsToOutputContract(form)
    assert.deepEqual(stored, {
      fields: [{ name: 'note', type: 'string', required: true }],
    })
  })

  if (failures > 0) {
    console.log(`\n${failures} failed`)
    process.exit(1)
  }
  console.log('\nAll passed.')
}

main()
