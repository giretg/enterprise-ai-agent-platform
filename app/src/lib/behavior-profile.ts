/**
 * A ténylegesen használt viselkedés-profil ("hogyan") két rétegből áll (§3.4):
 *
 *   effektív = megosztott profil pinnelt törzse  +  agent-specifikus overlay
 *
 * A megosztott profil a céges, újrahasznosítható hangnem/formázás; az overlay az
 * a rész, ami csak erre az agentre igaz. Egy helyen komponáljuk össze, hogy a
 * runtime (composeSystemPrompt) és a megjelenítés is ugyanazt lássa, és a
 * reprodukálhatósági snapshot az effektív szöveget fagyassza.
 */
export function composeBehaviorProfile(
  profileBody?: string | null,
  overlay?: string | null,
): string {
  return [profileBody?.trim(), overlay?.trim()].filter(Boolean).join('\n\n')
}

/**
 * Megjelenítéshez: az agent egyedi (overlay) részének kinyerése úgy, hogy a régi,
 * overlay-oszlop előtti sorokat is helyesen kezelje. Ha nincs kitöltött overlay:
 *  - megosztott profilhoz kötött agentnél nincs egyedi rész (üres),
 *  - egyébként a teljes `behaviorProfile` maga az egyedi rész (legacy inline szöveg).
 */
export function resolveBehaviorOverlay(agent: {
  behaviorProfile: string
  behaviorProfileOverlay: string | null
  currentBehaviorProfileId: string | null
}): string {
  if (agent.behaviorProfileOverlay != null) return agent.behaviorProfileOverlay
  return agent.currentBehaviorProfileId ? '' : agent.behaviorProfile
}
