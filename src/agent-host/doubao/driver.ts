// Doubao CLI's driver: one `doubao -p - --output-format stream-json` per turn, spawned by the
// agent host (see connection.ts).

import type { HostedDriver } from '../driver'
import { DoubaoConnection } from './connection'

export const DOUBAO_DRIVER: HostedDriver = {
  kind: 'hosted',
  connect: (context) => new DoubaoConnection(context),
}
