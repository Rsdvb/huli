// Settings › Artifact 权限: the pages the user allowed to read project files or ask the agent, and
// taking that back.

import type { ArtifactConsentRow } from '@shared/artifact-capabilities'
import { useHost } from '../../host'
import {
  baseName,
  Button,
  call,
  confirm,
  ManagePage,
  ReadState,
  useActions,
  useConnected,
  useRead,
} from '../../manage/kit'
import { EmptyState } from '../../ui/EmptyState'
import { ListGroup, ListRow } from '../../ui/ListRow'

export default function ArtifactConsents() {
  const host = useHost()
  const connected = useConnected()
  const read = useRead<ArtifactConsentRow[]>(
    'consents',
    (link) => call(link, 'artifacts.consents', undefined),
    ['artifacts.consentsChanged'],
  )
  const actions = useActions()
  const where = (row: ArtifactConsentRow) =>
    row.project
      ? (host.projects.find((p) => p.path === row.project)?.name ?? baseName(row.project))
      : '无项目'

  const revoke = async (row: ArtifactConsentRow) => {
    const ok = await confirm({
      title: `收回“${row.title}”的权限？`,
      message: '它下次要读取项目文件或向你的 Agent 提问时，会再问你。',
      confirm: '收回',
    })
    if (!ok || !host.link) return
    const done = await actions.run(
      row.artifactId,
      () => call(host.link!, 'artifacts.revokeConsent', { id: row.artifactId }),
      '没能收回权限',
    )
    if (done) read.set((rows) => rows.filter((r) => r.artifactId !== row.artifactId))
  }

  return (
    <ManagePage
      title="Artifact 权限"
      intro="页面要读取项目文件或向你的 Agent 提问时会先问你。只保存自己数据的页面不会问。"
      onRefresh={read.reload}
    >
      {read.value === null ? (
        <ReadState read={read} what="权限" icon="shield" rows={3} />
      ) : read.value.length === 0 ? (
        <EmptyState
          icon="shield"
          title="没有页面权限"
          message="页面请求读取项目文件或向你的 Agent 提问、你允许后，会列在这里。"
        />
      ) : (
        <ListGroup header="页面权限">
          {read.value.map((row) => (
            <ListRow
              key={row.artifactId}
              title={row.title}
              subtitle={[
                where(row),
                row.capabilities
                  .map((capability) =>
                    capability === 'files' ? '读取文件' : `询问 ${row.agent ?? '你的 Agent'}`,
                  )
                  .join('、'),
              ].join(' · ')}
              icon="canvas"
              plainIcon
              trailing={
                <Button
                  label="收回"
                  busy={actions.busy(row.artifactId)}
                  disabled={!connected}
                  onPress={() => void revoke(row)}
                />
              }
            />
          ))}
        </ListGroup>
      )}
    </ManagePage>
  )
}
