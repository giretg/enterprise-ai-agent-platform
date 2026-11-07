/**
 * A Konnektorok lista és a Wikik és jogok panel közös szövegei: melyik tudásbázis, mi van benne,
 * és mit tehet vele a munkatárs.
 *
 * Futtatás: npm run test:agent-kb-binding-summary
 */
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'

import enMessages from '../src/messages/en.json'
import huMessages from '../src/messages/hu.json'
import {
  KbBindingStatusLine,
  useAgentKbCopy,
  type AgentKbBindingInfo,
  type AgentKbCopy,
} from '../src/components/agents/agent-kb-binding-summary'

const base: AgentKbBindingInfo = {
  connectorId: '11111111-1111-4111-8111-111111111111',
  kind: 'shared',
  own: false,
  name: 'Termékwiki',
  access: 'write',
  writeMode: 'approval',
  sourceCount: 31,
  pageCount: 80,
}

function inProvider(locale: 'hu' | 'en', child: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(
    createElement(
      NextIntlClientProvider,
      { locale, messages: locale === 'hu' ? huMessages : enMessages, timeZone: 'Europe/Budapest' },
      child,
    ),
  )
}

function copyOf(info: AgentKbBindingInfo, accessMode?: 'read' | 'write', locale: 'hu' | 'en' = 'hu'): AgentKbCopy {
  let result: AgentKbCopy | null = null
  function Probe() {
    result = useAgentKbCopy()(info, accessMode)
    return null
  }
  inProvider(locale, createElement(Probe))
  assert.ok(result)
  return result
}

// Két munkatárs-tudásbázis nem kaphatja ugyanazt a címet: a saját és a másiké különbözik.
const own = copyOf({ ...base, kind: 'agent', own: true, name: 'Anna', access: 'read', sourceCount: 0, pageCount: 0 }, 'write')
const other = copyOf({ ...base, kind: 'agent', name: 'Béla', access: 'none' }, 'write')
assert.equal(own.title, 'Saját tudásbázis')
assert.equal(other.title, 'Béla tudásbázisa')
assert.equal(other.kindLabel, 'Másik munkatársé')

// Üres tudásbázisnál nem darabszám, hanem kimondott állapot látszik.
assert.equal(own.contents, 'Még üres')
assert.equal(own.rights, 'Olvashatja · Feltölthet dokumentumot')

// A `none` hozzáférésű kapcsolat nem hirdethet jogot, akkor sem, ha a kötés módja `write`.
assert.equal(other.unreachable, true)
assert.equal(other.rights, '')
assert.equal(other.contents, '31 dokumentum · 80 wiki-oldal')

// A nyilvános tudásbázis érthető nevet és a tartalmat kimondó címkét kap (#1139).
const publicKb = copyOf({ ...base, kind: 'public', name: 'Webes asszisztens' })
assert.equal(publicKb.title, 'Webes asszisztens nyilvános anyagai')
assert.equal(publicKb.kindLabel, 'Nyilvános')

// A megosztott tudásbázis a saját nevén jelenik meg, a jog a tényleges szint szerint.
const shared = copyOf(base, 'write')
assert.equal(shared.title, 'Termékwiki')
assert.equal(shared.kindLabel, 'Megosztott')
assert.equal(shared.rights, 'Írhatja a wikit, jóváhagyással · Feltölthet dokumentumot')
assert.equal(copyOf({ ...base, writeMode: 'direct' }, 'write').rights, 'Írhatja a wikit, közvetlenül · Feltölthet dokumentumot')
assert.equal(copyOf({ ...base, access: 'submit' }, 'read').rights, 'Beküldhet a tálcára')

// A szerviz belső angol tartaléknevei nem jutnak a felületre.
assert.equal(copyOf({ ...base, kind: 'catalog', name: 'Company knowledge base' }, 'read').title, 'Közös tudásbázis')
assert.equal(copyOf({ ...base, kind: 'agent', name: 'Agent knowledge base' }, 'read').title, 'Másik munkatárs tudásbázisa')

// Angolul is teljes a szöveg, helyes többes számmal.
const en = copyOf({ ...base, kind: 'agent', name: 'Béla', sourceCount: 1, pageCount: 2 }, 'write', 'en')
assert.equal(en.title, "Béla's knowledge base")
assert.equal(en.contents, '1 document · 2 wiki pages')

// Az elérhetetlen sor nem mutat jogot, kimondja az okot, és a beállításhoz visz.
const line = inProvider('hu', createElement(KbBindingStatusLine, { agentId: 'agent-1', copy: other }))
assert.match(line, /a munkatárs most nem éri el/)
assert.match(line, /\/control-plane\/agents\/agent-1\?section=tudasbazis/)
assert.doesNotMatch(line, /Feltölthet/)
assert.doesNotMatch(line, /knowledge_base/)

console.log('OK agent-kb-binding-summary')
