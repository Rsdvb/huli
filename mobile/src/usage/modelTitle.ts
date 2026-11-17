// A model id as a person reads it, for rows too narrow for the id: "claude-opus-5-5" is "Opus 5.5",
// "claude-3-5-sonnet-20241022" is "Sonnet 3.5", "gpt-6.1-sol" is "GPT-6.1 Sol" and
// "gemini-3-pro-preview" is "Gemini 3 Pro Preview". An id it does not know stays as it is.

const cap = (word: string) => word.charAt(0).toUpperCase() + word.slice(1)

export function modelTitle(id: string): string {
  const name = id.trim().replace(/^(anthropic|openai|google|models)\//i, '')
  // A trailing release date says nothing a person needs.
  const plain = name.replace(/-(\d{8}|latest)$/i, '')

  // claude-<family>-<major>[-<minor>], the current naming.
  const current = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-([a-z][\w-]*))?$/i.exec(plain)
  if (current) {
    const [, family, major, minor, rest] = current
    const version = minor ? `${major}.${minor}` : major
    return [cap(family!), version, rest ? rest.split('-').map(cap).join(' ') : null]
      .filter(Boolean)
      .join(' ')
  }
  // claude-<major>[-<minor>]-<family>, the older naming.
  const older = /^claude-(\d+)(?:-(\d+))?-([a-z]+)$/i.exec(plain)
  if (older) {
    const [, major, minor, family] = older
    return `${cap(family!)} ${minor ? `${major}.${minor}` : major}`
  }
  // gpt-<version>[-<variant>…]
  const gpt = /^gpt-([\d.]+[a-z]?)(?:-(.+))?$/i.exec(plain)
  if (gpt) {
    const [, version, rest] = gpt
    return [`GPT-${version}`, rest ? rest.split('-').map(cap).join(' ') : null]
      .filter(Boolean)
      .join(' ')
  }
  // gemini-<version>-<variant>…, and the like that read well with spaces.
  if (/^(gemini|kimi|qwen|deepseek|glm|grok|mistral|llama)[-\d]/i.test(plain)) {
    return plain.split('-').map(cap).join(' ')
  }
  return name
}
