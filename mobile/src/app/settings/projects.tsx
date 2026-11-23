// Settings › 项目: the computer's projects, each opening its page, and adding one: by typing its
// folder on the computer, which the computer completes as it is typed, or (Huli) by cloning a
// repository or making an empty project in a folder the computer offers.

import { useRef, useState } from 'react'
import { router } from 'expo-router'
import type { Project } from '@shared/agent-host'
import { Sheet } from '../../components/Sheet'
import { useHost } from '../../host'
import { FolderPathSheet } from '../../manage/FolderPathSheet'
import { call, homeShort, ManagePage, Tag, useConnected } from '../../manage/kit'
import { NewProjectSheet, type NewProjectKind } from '../../manage/NewProjectSheet'
import { EmptyState } from '../../ui/EmptyState'
import { ListGroup, ListRow } from '../../ui/ListRow'
import { SkeletonRows } from '../../ui/Skeleton'

export default function ProjectsSettings() {
  const host = useHost()
  const connected = useConnected()
  const [adding, setAdding] = useState<AddStep | null>(null)
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
      overlay={<AddProject step={adding} onStep={setAdding} />}
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
          action={connected ? { label: '添加项目', onPress: () => setAdding('menu') } : undefined}
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
            onPress={() => setAdding('menu')}
          />
        </ListGroup>
      ) : null}
    </ManagePage>
  )
}

type AddStep = 'menu' | 'open' | NewProjectKind

/**
 * Adding a project: a choice of three, then its sheet. Open folder takes its folder's path on the
 * computer, as FolderPathSheet takes it; the other two make a project in a folder it offers.
 */
function AddProject(props: { step: AddStep | null; onStep(step: AddStep | null): void }) {
  const host = useHost()
  // The last sheet stays mounted while it leaves, so it slides away as it was.
  const kind = useRef<NewProjectKind>('clone')
  if (props.step === 'clone' || props.step === 'empty') kind.current = props.step
  // The sheet closes itself first and takes the choice once it has left.
  const next = (step: AddStep) => props.onStep(step)
  const opened = (project: Project) => {
    props.onStep(null)
    void host.refresh().catch(() => {})
    router.push({ pathname: '/settings/project', params: { path: project.path } })
  }
  return (
    <>
      <Sheet
        visible={props.step === 'menu'}
        title="添加项目"
        onClose={() => props.onStep(null)}
        items={[
          {
            key: 'open',
            label: '打开文件夹…',
            detail: '电脑上已有的文件夹',
            onPress: () => next('open'),
          },
          {
            key: 'clone',
            label: '从 Git 克隆…',
            detail: '用仓库地址克隆到电脑上',
            onPress: () => next('clone'),
          },
          {
            key: 'empty',
            label: '新建空项目…',
            detail: '新建文件夹并运行 git init',
            onPress: () => next('empty'),
          },
        ]}
      />
      <FolderPathSheet
        visible={props.step === 'open'}
        onClose={() => props.onStep(null)}
        title="打开文件夹"
        message="输入电脑上一个文件夹的路径，从主目录 ~ 开始，或写完整路径。"
        submitLabel="添加"
        onChosen={async (chosen) => {
          if (!host.link) throw new Error('电脑没有连上。')
          opened(await call(host.link, 'projects.add', { path: chosen }))
        }}
      />
      <NewProjectSheet
        kind={kind.current}
        visible={props.step === 'clone' || props.step === 'empty'}
        onClose={() => props.onStep(null)}
        onDone={opened}
      />
    </>
  )
}
