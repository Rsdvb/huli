// Huli: KaTeX's stylesheet for the page a PDF prints, its fonts inlined as data so the page loads
// nothing. Only the page worker imports it, the fonts with the bundle's `?inline`.

import css from 'katex/dist/katex.min.css?raw'
import AMS_REGULAR from 'katex/dist/fonts/KaTeX_AMS-Regular.woff2?inline'
import CALIGRAPHIC_BOLD from 'katex/dist/fonts/KaTeX_Caligraphic-Bold.woff2?inline'
import CALIGRAPHIC_REGULAR from 'katex/dist/fonts/KaTeX_Caligraphic-Regular.woff2?inline'
import FRAKTUR_BOLD from 'katex/dist/fonts/KaTeX_Fraktur-Bold.woff2?inline'
import FRAKTUR_REGULAR from 'katex/dist/fonts/KaTeX_Fraktur-Regular.woff2?inline'
import MAIN_BOLD from 'katex/dist/fonts/KaTeX_Main-Bold.woff2?inline'
import MAIN_BOLD_ITALIC from 'katex/dist/fonts/KaTeX_Main-BoldItalic.woff2?inline'
import MAIN_ITALIC from 'katex/dist/fonts/KaTeX_Main-Italic.woff2?inline'
import MAIN_REGULAR from 'katex/dist/fonts/KaTeX_Main-Regular.woff2?inline'
import MATH_BOLD_ITALIC from 'katex/dist/fonts/KaTeX_Math-BoldItalic.woff2?inline'
import MATH_ITALIC from 'katex/dist/fonts/KaTeX_Math-Italic.woff2?inline'
import SANS_SERIF_BOLD from 'katex/dist/fonts/KaTeX_SansSerif-Bold.woff2?inline'
import SANS_SERIF_ITALIC from 'katex/dist/fonts/KaTeX_SansSerif-Italic.woff2?inline'
import SANS_SERIF_REGULAR from 'katex/dist/fonts/KaTeX_SansSerif-Regular.woff2?inline'
import SCRIPT_REGULAR from 'katex/dist/fonts/KaTeX_Script-Regular.woff2?inline'
import SIZE1_REGULAR from 'katex/dist/fonts/KaTeX_Size1-Regular.woff2?inline'
import SIZE2_REGULAR from 'katex/dist/fonts/KaTeX_Size2-Regular.woff2?inline'
import SIZE3_REGULAR from 'katex/dist/fonts/KaTeX_Size3-Regular.woff2?inline'
import SIZE4_REGULAR from 'katex/dist/fonts/KaTeX_Size4-Regular.woff2?inline'
import TYPEWRITER_REGULAR from 'katex/dist/fonts/KaTeX_Typewriter-Regular.woff2?inline'

const FONTS: Record<string, string> = {
  'KaTeX_AMS-Regular': AMS_REGULAR,
  'KaTeX_Caligraphic-Bold': CALIGRAPHIC_BOLD,
  'KaTeX_Caligraphic-Regular': CALIGRAPHIC_REGULAR,
  'KaTeX_Fraktur-Bold': FRAKTUR_BOLD,
  'KaTeX_Fraktur-Regular': FRAKTUR_REGULAR,
  'KaTeX_Main-Bold': MAIN_BOLD,
  'KaTeX_Main-BoldItalic': MAIN_BOLD_ITALIC,
  'KaTeX_Main-Italic': MAIN_ITALIC,
  'KaTeX_Main-Regular': MAIN_REGULAR,
  'KaTeX_Math-BoldItalic': MATH_BOLD_ITALIC,
  'KaTeX_Math-Italic': MATH_ITALIC,
  'KaTeX_SansSerif-Bold': SANS_SERIF_BOLD,
  'KaTeX_SansSerif-Italic': SANS_SERIF_ITALIC,
  'KaTeX_SansSerif-Regular': SANS_SERIF_REGULAR,
  'KaTeX_Script-Regular': SCRIPT_REGULAR,
  'KaTeX_Size1-Regular': SIZE1_REGULAR,
  'KaTeX_Size2-Regular': SIZE2_REGULAR,
  'KaTeX_Size3-Regular': SIZE3_REGULAR,
  'KaTeX_Size4-Regular': SIZE4_REGULAR,
  'KaTeX_Typewriter-Regular': TYPEWRITER_REGULAR,
}

// Each face's sources: `url(fonts/<name>.woff2) format("woff2")`, then its WOFF and TTF.
const SOURCES = /src:url\(fonts\/(KaTeX_[\w-]+)\.woff2\)[^;}]*/g

let made: string | null = null

/** KaTeX's stylesheet, each face from its WOFF2 alone, inlined. */
export function mathStyle(): string {
  made ??= css.replace(SOURCES, (all, name: string) => {
    const data = FONTS[name]
    return data ? `src:url(${data}) format("woff2")` : all
  })
  return made
}
