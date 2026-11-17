// The tab the user was on, for the tab bar's new-session item to return to.

let last = 'index'

export function rememberTab(name: string): void {
  if (name !== 'compose') last = name
}

export function lastTab(): string {
  return last
}
