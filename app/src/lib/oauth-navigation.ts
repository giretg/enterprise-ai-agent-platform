/** OAuth providers block consent pages in nested frames. */
export function oauthNavigationTarget<T>(current: T, top: T | null): T {
  return top ?? current
}

export function navigateToOAuth(url: string) {
  oauthNavigationTarget<Window>(window, window.top).location.assign(url)
}
