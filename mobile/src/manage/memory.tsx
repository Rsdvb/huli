// What Settings › 记忆 and an entry's page share: the host's reasons for refusing a memory request in
// the user's words, who wrote an entry, and the editor sheet for a new or changed entry.

import { useEffect, useState } from 'react'
import type { MemoryEntry, MemoryScope } from '@shared/memory'
import { MEMORY_BODY_CHARS, MEMORY_DESCRIPTION_CHARS, MEMORY_TITLE_CHARS } from '@shared/memory'
import type { HostLink } from '@shared/remote/link'
import { useHost } from '../host'
import { ago } from '../sessions'
import { call, errorText, Field, FieldLabel, FormSheet } from './kit'

const REASONS: Record<string, string> = {
  memory_secret: '这里面像是有密钥或密码之类的机密，记忆不保存这些。',
  memory_full: '这里的记忆已满，先删掉一些再加。',
  memory_changed: '这次写入之后记忆又被改过，所以保持原样。',
  memory_gone: '这次写入已经不能撤销了。',
  memory_off: '记忆已关上。',
  memory_not_found: '这条记忆已经不在了。',
}

/** Why a memory request failed: the host's refusal in the user's words, else its own. */
export function memoryError(failure: unknown): Error {
  const reason = (failure as { data?: { reason?: unknown } } | null)?.data?.reason
  const text = typeof reason === 'string' ? REASONS[reason] : undefined
  return new Error(text ?? errorText(failure))
}

/** Runs a memory request, failing with the refusal's reason. */
export async function memoryCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (failure) {
    throw memoryError(failure)
  }
}

/** The scope as a route parameter: `global`, or the project's path. */
export function scopeParam(scope: MemoryScope): string {
  return scope.layer === 'global' ? 'global' : scope.project
}

export function scopeOf(param: string): MemoryScope {
  return param === 'global' ? { layer: 'global' } : { layer: 'project', project: param }
}

/** 「Claude Code · 3 分钟前」, or 「你 · …」 for the user's own entry. */
export function useEntryLine(): (entry: MemoryEntry) => string {
  const host = useHost()
  return (entry) => {
    const who =
      entry.source.agentId === null
        ? '你'
        : (host.agents.get(entry.source.agentId)?.name ?? entry.source.agentId)
    return `${who} · ${ago(entry.updatedAt)}`
  }
}

export function saveEntry(
  link: HostLink,
  scope: MemoryScope,
  id: string | null,
  draft: { title: string; description: string; body: string },
): Promise<MemoryEntry> {
  return memoryCall(() => call(link, 'memory.save', { scope, id, draft }))
}

/** A new entry, or one changed: its title, summary and text. */
export function EntryEditor(props: {
  visible: boolean
  scope: MemoryScope
  entry: MemoryEntry | null
  onClose(): void
  onSaved?(entry: MemoryEntry): void
}) {
  const host = useHost()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  useEffect(() => {
    if (!props.visible) return
    setTitle(props.entry?.title ?? '')
    setDescription(props.entry?.description ?? '')
    setBody(props.entry?.body ?? '')
  }, [props.visible, props.entry])
  return (
    <FormSheet
      visible={props.visible}
      title={props.entry ? '编辑' : '添加'}
      message={props.scope.layer === 'global' ? '全局' : undefined}
      onClose={props.onClose}
      submitLabel="保存"
      canSubmit={title.trim() !== '' && description.trim() !== ''}
      onSubmit={async () => {
        if (!host.link) throw new Error('电脑没有连上。')
        const saved = await saveEntry(host.link, props.scope, props.entry?.id ?? null, {
          title: title.trim(),
          description: description.trim(),
          body: body.trim(),
        })
        props.onSaved?.(saved)
      }}
    >
      <FieldLabel>标题</FieldLabel>
      <Field
        value={title}
        onChangeText={setTitle}
        maxLength={MEMORY_TITLE_CHARS}
        autoCapitalize="sentences"
        autoCorrect
        placeholder="简短的名字，例如“用 pnpm”"
        accessibilityLabel="标题"
      />
      <FieldLabel>摘要</FieldLabel>
      <Field
        value={description}
        onChangeText={setDescription}
        maxLength={MEMORY_DESCRIPTION_CHARS}
        autoCapitalize="sentences"
        autoCorrect
        placeholder="一行摘要，Agent 在记忆列表里看到的就是它"
        accessibilityLabel="摘要"
      />
      <FieldLabel>正文</FieldLabel>
      <Field
        value={body}
        onChangeText={setBody}
        maxLength={MEMORY_BODY_CHARS}
        multiline
        autoCapitalize="sentences"
        autoCorrect
        placeholder="用 Markdown 写。一条只写一件事，并写明为什么。"
        accessibilityLabel="正文"
      />
    </FormSheet>
  )
}
