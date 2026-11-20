// What to call an agent the computer no longer lists, as a removed one: its harness's name, as the
// desktop's agentName() falls back to (renderer/src/stores/agents.ts, AGENT_NAMES), never its id.

const HARNESS_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
  auggie: 'Auggie CLI',
  codebuddy: 'Codebuddy Code',
  deepagents: 'DeepAgents',
  dimcode: 'DimCode',
  dirac: 'Dirac',
  glm: 'GLM Agent',
  nova: 'Nova',
  qoder: 'Qoder CLI',
  'qoder-cn': 'Qoder CN',
  sigit: 'siGit Code',
  agoragentic: 'Agoragentic',
  autohand: 'Autohand Code',
  bob: 'Bob',
  minimax: 'MiniMax Code',
  cursor: 'Cursor',
  kimi: 'Kimi Code',
  amp: 'Amp',
  goose: 'goose',
  kilo: 'Kilo Code',
  gemini: 'Gemini CLI',
  copilot: 'GitHub Copilot',
  qwen: 'Qwen Code',
  grok: 'Grok',
  cline: 'Cline',
  droid: 'Factory Droid',
  omp: 'OMP',
  hermes: 'Hermes Agent',
  muse: 'Muse Code',
  codewhale: 'CodeWhale',
  deepseek: 'DeepSeek Harness',
  harn: 'Harn',
  kimchi: 'Kimchi',
  antigravity: 'Google Antigravity',
  devin: 'Devin',
  'cortex-code': 'Cortex Code',
  'corust-agent': 'Corust Agent',
  'crow-cli': 'crow-cli',
  junie: 'Junie',
  'mistral-vibe': 'Mistral Vibe',
  poolside: 'Poolside',
  stakpak: 'Stakpak',
  vtcode: 'VT Code',
  'fast-agent': 'fast-agent',
  minion: 'Minion Code',
  doubao: '豆包',
}

/** The agent's name, else its harness's (an added agent's id is its harness's, `~`, its own), else Agent. */
export function agentLabel(agentId: string, name?: string | null): string {
  if (name) return name
  const tilde = agentId.indexOf('~')
  return HARNESS_NAMES[tilde < 0 ? agentId : agentId.slice(0, tilde)] ?? 'Agent'
}
