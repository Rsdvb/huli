import { createContext } from 'react'
import type { ReviewRun } from '@shared/review'
import type { FindingSpot } from './review'

/** The review a diff's findings are drawn from, and where each of the file's findings goes. */
export interface Findings {
  sessionId: string
  review: ReviewRun | null
  spots: ReadonlyMap<string, FindingSpot>
}

export const FindingsContext = createContext<Findings | null>(null)
