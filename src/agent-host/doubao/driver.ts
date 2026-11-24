// Doubao CLI's driver: one `doubao -p - --output-format stream-json` per turn, spawned by the
// agent host (see connection.ts).

import { lazyCode, type HostedDriver } from '../driver'

const code = lazyCode(() => import('./connection'))

export const DOUBAO_DRIVER: HostedDriver = {
  kind: 'hosted',
  load: code.load,
  connect: (context) => new (code.get().DoubaoConnection)(context),
}
