// What the window shows when rendering throws, in place of a blank window: the error, and the way
// back by reloading, copying it or reporting it. The rest of the app runs in other processes, so
// the sessions go on while the window is down.

import { Component, useState, type ErrorInfo, type ReactNode } from 'react'
import { AlertCircleIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { ReportDialog } from '@renderer/features/report/report-dialog'
import { openReport } from '@renderer/stores/report'

interface CaughtProps {
  children: ReactNode
  /** What shows instead once rendering `children` threw, given the error and where it was. */
  fallback: (details: string) => ReactNode
}

interface CaughtState {
  error: Error | null
  details: string
}

/** Catches what rendering `children` throws and shows `fallback` instead of an empty window. */
export class CatchRender extends Component<CaughtProps, CaughtState> {
  state: CaughtState = { error: null, details: '' }

  static getDerivedStateFromError(thrown: unknown): Partial<CaughtState> {
    const error = thrown instanceof Error ? thrown : new Error(String(thrown))
    return { error, details: error.stack ?? `${error.name}: ${error.message}` }
  }

  componentDidCatch(thrown: unknown, info: ErrorInfo): void {
    console.error('The window failed to render', thrown, info.componentStack)
    if (info.componentStack) {
      this.setState((state) => ({
        details: `${state.details}\n\nComponents:${info.componentStack}`,
      }))
    }
  }

  render(): ReactNode {
    const { error, details } = this.state
    return error ? this.props.fallback(details) : this.props.children
  }
}

/** The window's own screen for an error that left it nothing to show. */
export function CrashScreen({ details }: { details: string }) {
  const { t } = useTranslation('common')
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard.writeText(details).then(
      () => setCopied(true),
      (e: unknown) => console.warn('Could not copy the error', e),
    )
  }
  const report = () => {
    void openReport({
      context: { sessionId: null, agentId: null, error: details },
      range: { kind: 'hour' },
    })
  }
  return (
    <TooltipProvider delay={500}>
      <div className="flex h-svh min-h-0 flex-col overflow-hidden bg-background text-foreground">
        {/* The window still moves by its top, as the hidden title bar's does on macOS. */}
        <div className="h-(--title-bar) shrink-0 app-region-drag" />
        <Empty className="min-h-0 overflow-auto">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={1.9} aria-hidden />
            </EmptyMedia>
            <EmptyTitle>{t('crash.title')}</EmptyTitle>
            <EmptyDescription>{t('crash.body')}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => window.location.reload()}>{t('crash.reload')}</Button>
              <Button variant="outline" onClick={copy}>
                {copied ? t('crash.copied') : t('crash.copy')}
              </Button>
              <Button variant="outline" onClick={report}>
                {t('crash.report')}
              </Button>
            </div>
            <details className="w-full text-left">
              <summary className="cursor-default text-small text-secondary">
                {t('crash.details')}
              </summary>
              <pre
                data-selectable=""
                className="mt-2 max-h-48 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs break-all whitespace-pre-wrap"
              >
                {details}
              </pre>
            </details>
          </EmptyContent>
        </Empty>
        {/* The report dialog, kept from taking the window down again should it fail too. */}
        <CatchRender fallback={() => null}>
          <ReportDialog />
        </CatchRender>
      </div>
    </TooltipProvider>
  )
}
