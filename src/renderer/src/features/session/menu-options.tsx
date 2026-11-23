// Huli: a session's options its agent offers in the session's menu rather than beside the
// composer (`place: 'menu'`), such as Claude Code's output style: each a submenu of its choices,
// the agent's own ones first and the user's own under their group's name.

import { Fragment } from 'react'
import { QuillWrite01Icon } from '@hugeicons/core-free-icons'
import type { ConfigOption } from '@shared/thread'
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { toast } from '@renderer/components/ui/toast'
import { MenuGlyph } from '@renderer/features/shell/glyph'
import { errorMessage, host } from '@renderer/lib/host'
import { useMenuOptions } from './menu-options-model'

export function MenuOptions({ sessionId }: { sessionId: string }) {
  const options = useMenuOptions(sessionId)
  return options.map((option) => (
    <MenuOption key={option.id} sessionId={sessionId} option={option} />
  ))
}

function MenuOption({ sessionId, option }: { sessionId: string; option: ConfigOption }) {
  const choices = option.choices ?? []
  const current = choices.find((choice) => choice.value === option.value)
  const groups: { name: string | undefined; choices: typeof choices }[] = []
  for (const choice of choices) {
    const last = groups.at(-1)
    if (last && last.name === choice.group) last.choices.push(choice)
    else groups.push({ name: choice.group, choices: [choice] })
  }
  const choose = (value: string) => {
    if (value === option.value) return
    host('sessions.setConfigOption', { sessionId, optionId: option.id, value }).catch(
      (error: unknown) => toast(errorMessage(error)),
    )
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <MenuGlyph icon={QuillWrite01Icon} />
        {option.name}
        <span className="ml-auto max-w-32 truncate pl-4 text-hint text-tertiary">
          {current?.name ?? String(option.value)}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-96 w-72 overflow-y-auto">
        {option.description && (
          <DropdownMenuLabel className="text-hint font-normal text-tertiary">
            {option.description}
          </DropdownMenuLabel>
        )}
        <DropdownMenuRadioGroup value={String(option.value)} onValueChange={choose}>
          {groups.map((group, index) => (
            <Fragment key={group.name ?? `own-${index}`}>
              {index > 0 && <DropdownMenuSeparator />}
              {group.name && <DropdownMenuLabel>{group.name}</DropdownMenuLabel>}
              {group.choices.map((choice) => (
                <DropdownMenuRadioItem key={choice.value} value={choice.value} closeOnClick>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{choice.name}</span>
                    {choice.description && (
                      <span className="text-hint text-tertiary">{choice.description}</span>
                    )}
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </Fragment>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
