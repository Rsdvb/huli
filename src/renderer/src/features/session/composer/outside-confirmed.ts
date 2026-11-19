// Huli: the sessions whose first message here, while a program outside Kettu has them open but
// idle, was confirmed. Kept for the app's run.
const confirmed = new Set<string>()

export const outsideConfirmed = (sessionId: string): boolean => confirmed.has(sessionId)

export function confirmOutside(sessionId: string): void {
  confirmed.add(sessionId)
}
