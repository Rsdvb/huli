// Every URL the system opens the app with passes here first. Huli's own links (src/links.ts) wait
// in LinkBridge until the app can show them, past Face ID and on the computer they name, so the
// router itself is told to stay where it is; any other URL goes on to the router as it is.

import { openLink, parseLink } from '../links'

export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  try {
    const link = parseLink(path)
    if (!link) return path
    openLink(link)
    return initial ? '/' : null
  } catch {
    return initial ? '/' : path
  }
}
