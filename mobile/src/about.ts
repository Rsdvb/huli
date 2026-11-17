// Where Huli lives and whose work it is built on, for Settings › 关于 and 致谢.

export const GITHUB_URL = 'https://github.com/Rsdvb/huli'
export const PRIVACY_URL = 'https://huli.132-145-200-0.sslip.io/privacy'
export const KETTU_URL = 'https://github.com/KettuAI/Kettu'

export interface Credit {
  name: string
  license: string
  url: string
  /** What it does in the app, or whose it is. */
  note?: string
}

/** The libraries the app ships, with the licenses their packages declare. */
export const LIBRARIES: Credit[] = [
  { name: 'Expo 与 Expo 模块', license: 'MIT', url: 'https://github.com/expo/expo' },
  { name: 'Expo Router', license: 'MIT', url: 'https://github.com/expo/expo' },
  { name: 'React', license: 'MIT', url: 'https://github.com/facebook/react' },
  { name: 'React Native', license: 'MIT', url: 'https://github.com/facebook/react-native' },
  {
    name: 'react-native-screens',
    license: 'MIT',
    url: 'https://github.com/software-mansion/react-native-screens',
  },
  {
    name: 'react-native-safe-area-context',
    license: 'MIT',
    url: 'https://github.com/AppAndFlow/react-native-safe-area-context',
  },
  {
    name: 'react-native-svg',
    license: 'MIT',
    url: 'https://github.com/software-mansion/react-native-svg',
  },
  { name: 'Lucide', license: 'ISC', url: 'https://github.com/lucide-icons/lucide', note: '图标' },
  {
    name: 'noble-ciphers、noble-curves、noble-hashes',
    license: 'MIT',
    url: 'https://github.com/paulmillr/noble-curves',
    note: '端到端加密',
  },
  { name: 'fflate', license: 'MIT', url: 'https://github.com/101arrowz/fflate' },
  { name: 'i18next', license: 'MIT', url: 'https://github.com/i18next/i18next' },
]

/** The agents' marks, each under its owner's terms, as src/ui/agent-marks.tsx notes them. */
export const MARKS: Credit[] = [
  {
    name: 'Claude',
    license: 'Apache-2.0',
    url: 'https://github.com/agentclientprotocol/registry',
    note: 'ACP Registry',
  },
  { name: 'Codex', license: 'MIT', url: 'https://github.com/lobehub/lobe-icons', note: 'LobeHub' },
  { name: 'OpenCode', license: 'MIT', url: 'https://github.com/sst/opencode' },
  { name: 'Pi', license: 'MIT', url: 'https://pi.dev' },
  { name: 'Gemini CLI', license: 'Apache-2.0', url: 'https://geminicli.com' },
  { name: 'DeepSeek', license: 'MIT', url: 'https://github.com/deepseek-ai' },
  { name: 'Qwen Code', license: 'Apache-2.0', url: 'https://github.com/QwenLM/qwen-code' },
  {
    name: 'Kimi',
    license: '品牌指南',
    url: 'https://github.com/MoonshotAI/Branding-Guide',
  },
]
