import type { AgentDefinition } from '../catalog'
import { SIGN_IN_METHOD } from '../doubao/sign-in'
import { DOUBAO_CLI, DOUBAO_PACKAGE } from '../doubao/program'
import { t } from '../i18n'

// ByteDance's Doubao CLI, run one `doubao -p - --output-format stream-json` per turn (see
// doubao/connection.ts). Kettu runs the user's own install from npm, whose install script fetches
// the native program, and never installs it in its data folder: the program updates itself.
export const DOUBAO: AgentDefinition = {
  id: 'doubao',
  // 豆包 in Chinese.
  get name() {
    return t('doubao.name')
  },
  registryId: 'doubao-cli',
  protocol: 'doubao-cli',
  launch: { kind: 'binary', command: 'doubao', args: [] },
  install: {
    hint: 'detect.hint.doubao',
    url: 'https://www.npmjs.com/package/@bytedance/doubao-cli',
    notice: 'detect.doubaoInstallNotice',
  },
  installs: { npm: DOUBAO_PACKAGE, allowScripts: true },
  cli: DOUBAO_CLI,
  limitsReason: 'harness-does-not-offer',
  // Its QR code shows on the client that asked, where the phone that scans it may be.
  pageSignIns: [SIGN_IN_METHOD],
}
