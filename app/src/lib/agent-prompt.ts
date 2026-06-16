// A futtatáskor használt rendszer-prompt a két, külön verziózott összetevőből
// áll össze (§5.3): a szerep-instrukcióból ("mit csinál") és a viselkedés-
// profilból ("hogyan"). Egy helyen rakjuk össze, hogy minden runtime ugyanazt a
// kompozíciót lássa.
export function composeSystemPrompt(agent: {
  roleInstruction: string
  behaviorProfile: string
}): string {
  return [agent.roleInstruction.trim(), agent.behaviorProfile.trim()]
    .filter(Boolean)
    .join('\n\n')
}
