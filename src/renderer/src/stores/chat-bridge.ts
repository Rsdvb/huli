// Huli: the chat bridges as main shows them, for Settings › 聊天软件: which credentials are set (a
// secret by its last characters), the bound accounts, each connection and the binding under way.

import { useEffect } from 'react'
import { create } from 'zustand'
import type { ChatBridgeView } from '@shared/chat-bridge'

interface ChatBridgeStore {
  view: ChatBridgeView | null
  error: string | null
}

export const useChatBridgeStore = create<ChatBridgeStore>()(() => ({ view: null, error: null }))

let following = false

/** Reads the view once and follows it from then on; the web client has no chat bridges. */
export function useFollowChatBridge(): void {
  useEffect(() => {
    const api = window.kettu.chatBridge
    if (following || !api) return
    following = true
    api.onChanged((view) => useChatBridgeStore.setState({ view }))
    void api.state().then(
      (view) => useChatBridgeStore.setState({ view, error: null }),
      (error: unknown) =>
        useChatBridgeStore.setState({
          error: error instanceof Error ? error.message : String(error),
        }),
    )
  }, [])
}

/** Keeps an answer of main's, which is the whole view after the change. */
export function keepView(view: ChatBridgeView): void {
  useChatBridgeStore.setState({ view, error: null })
}
