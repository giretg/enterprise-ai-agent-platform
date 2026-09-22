import type { SkillContent } from './skill-content'

/**
 * A platform egyetlen gyártó skillje. Kiadott (global): minden tenant látja és
 * az adminja agenthez rendelheti. A jelölő (`producesSkills`) a kapu — a szöveg
 * a modellnek szól. A katalógus-űrlap továbbra sem tehet gyártó jelölőt kiadott
 * skillre; ezt a sort csak ez a definíció hozza létre.
 */
export const SKILL_PRODUCER_NAME = 'skill-keszito'

export const SKILL_PRODUCER_DISPLAY_NAME = 'Skill készítő'

export const SKILL_PRODUCER_DESCRIPTION =
  'Beszélgetésből új skill készítése. Használd, ha a felhasználó azt kéri, hogy ebből a beszélgetésből, ebből a munkamenetből vagy ebből a szokásból skill legyen. A beküldés csak azon az agenten megy át, amelyhez ez a skill hozzá van rendelve és be van kapcsolva.'

export const SKILL_PRODUCER_INSTRUCTIONS = `A felhasználó skillt akar ebből a beszélgetésből. A szöveget te írod. A platform nem fogalmaz helyetted: a platform.skills.submit hívás kapuz és tárol. Ne hívj, amíg a felhasználó ezt kifejezetten nem kérte.

1. Az agentId-t a platform.agents.list válaszából vedd, vagy abból az agentből, amellyel a felhasználó dolgozik. Ha több agent látszik és nem nevez meg egyet, kérdezd meg, melyikhez kerüljön az új skill. Ne találj ki azonosítót.

2. A skill a beszélgetésben már bevált lépéseket rögzítse. Technikai név: kisbetű, szám, kötőjel. A leírás egy-két mondat: mikor kell elővenni. Az instrukció a konkrét lépés. Hiányzó tényt ne tölts ki, és ne ígérj olyan eszközt, ami a beszélgetésben nem került elő.

3. Hívd a platform.skills.submit eszközt ezekkel a mezőkkel:
   - agentId, name, description, instructions
   - requires: JSON-szöveg, nem tömb. Elemei {toolName, reason}. Hagyd el, ha nincs eszközigény. Példa: [{"toolName":"kb_search","reason":"a tudástár olvasása"}]
   - attachments: JSON-szöveg, nem tömb. Elemei {path, text}. Hagyd el, ha nincs melléklet.

4. A szerver válaszát add tovább a felhasználónak, ne írd át:
   - létrejött és él: hozzá van rendelve ehhez az agenthez, és be van kapcsolva
   - jóváhagyásra vár: tenant admin a képességek katalógusában bírálja
   - elutasítva: az okot mondd el (nincs bekapcsolt gyártó skill, az agent nem használható, validációs hiba, foglalt név)
   Foglalt névnél hívj újra másik névvel. Validációs hibánál javíts, és hívj újra.

5. A hívás nem ad eszközjogot. Ha a válasz hiányzó eszközöket sorol, mondd el: azokat az admin az agent adatlapján adja meg.

6. Ezzel az úttal nem lehet gyártó skillt csinálni. A létrejött skill közönséges tenant skill, csak a megnevezett agenthez rendelve.`

export function skillProducerContent(): SkillContent {
  return {
    instructions: [SKILL_PRODUCER_INSTRUCTIONS],
    triggerKeywords: [
      'készíts skillt',
      'ebből a beszélgetésből',
      'skill legyen',
      'mentsd el skillként',
    ],
    parameters: [],
  }
}

/** Tenant gyártó skillje, vagy a kiadott platform-skill (tenantId null). */
export function producerSkillWhere(tenantId: string): {
  producesSkills: true
  OR: Array<{ tenantId: string | null }>
} {
  return {
    producesSkills: true,
    OR: [{ tenantId }, { tenantId: null }],
  }
}
