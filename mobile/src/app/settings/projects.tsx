// Settings › 项目: the computer's projects, each opening its page, and adding one by typing its
// folder on the computer, which the computer completes as it is typed.

import { useState } from 'react'
import { router } from 'expo-router'
import { useHost } from '../../host'
import { FolderPathSheet } from '../../manage/FolderPathSheet'
import { call, homeShort, ManagePage, Tag, useConnected } from '../../manage/kit'
import { EmptyState } from '../../ui/EmptyState'
import { ListGroup, ListRow } from '../../ui/ListRow'
import { SkeletonRows } from '../../ui/Skeleton'

export default function ProjectsSettings() {
  const host = useHost()
  const connected = useConnected()
  const [adding, setAdding] = useState(false)
  const counts = new Map<string, number>()
  for (const session of host.sessions.values()) {
    if (session.archivedAt !== null) continue
    counts.set(session.projectPath, (counts.get(session.projectPath) ?? 0) + 1)
  }
  const projects = [...host.projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)

  return (
    <ManagePage
      title="项目"
      intro="电脑上纸鸢里的项目。移除项目不会动它的文件夹。"
      onRefresh={() => host.refresh()}
      overlay={<AddProjectSheet visible={adding} onClose={() => setAdding(false)} />}
    >
      {!host.loaded ? (
        connected ? (
          <SkeletonRows count={4} avatar={false} />
        ) : (
          <EmptyState icon="folder" title="连上电脑后才能看项目" />
        )
      ) : projects.length === 0 ? (
        <EmptyState
          icon="folder"
          title="还没有项目"
          message="添加电脑上的一个文件夹，就能在里面开始会话。"
          action={connected ? { label: '添加项目', onPress: () => setAdding(true) } : undefined}
        />
      ) : (
        <ListGroup>
          {projects.map((project) => (
            <ListRow
              key={project.path}
              title={project.name}
              subtitle={homeShort(project.path)}
              icon="folder"
              plainIcon
              value={
                !project.missing && counts.get(project.path)
                  ? `${counts.get(project.path)} 个会话`
                  : undefined
              }
              trailing={project.missing ? <Tag label="未找到" tone="warning" /> : undefined}
              chevron
              onPress={() =>
                router.push({ pathname: '/settings/project', params: { path: project.path } })
              }
            />
          ))}
        </ListGroup>
      )}
      {host.loaded ? (
        <ListGroup>
          <ListRow
            title="添加项目"
            icon="folderPlus"
            plainIcon
            action
            disabled={!connected}
            onPress={() => setAdding(true)}
          />
        </ListGroup>
      ) : null}
    </ManagePage>
  )
}

/** Adding a project: its folder's path on the computer, as FolderPathSheet takes it. */
function AddProjectSheet(props: { visible: boolean; onClose(): void }) {
  const host = useHost()
  return (
    <FolderPathSheet
      visible={props.visible}
      onClose={props.onClose}
      title="添加项目"
      message="输入电脑上一个文件夹的路径，从主目录 ~ 开始，或写完整路径。"
      submitLabel="添加"
      onChosen={async (chosen) => {
        if (!host.link) throw new Error('电脑没有连上。')
        const project = await call(host.link, 'projects.add', { path: chosen })
        void host.refresh().catch(() => {})
        router.push({ pathname: '/settings/project', params: { path: project.path } })
      }}
    />
  )
}
