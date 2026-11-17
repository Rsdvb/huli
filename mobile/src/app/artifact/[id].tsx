// An artifact, full screen: `/artifact/<id>`, with `version` for an older one and `page` for a
// canvas page by its id or number.

import { useLocalSearchParams } from 'expo-router'
import { ArtifactViewer } from '../../artifact-view/ArtifactViewer'

export default function ArtifactScreen() {
  const params = useLocalSearchParams<{ id: string; version?: string; page?: string }>()
  const version =
    params.version && /^[1-9][0-9]{0,8}$/.test(params.version) ? Number(params.version) : null
  return (
    <ArtifactViewer
      key={`${params.id}:${version ?? ''}`}
      id={params.id}
      version={version}
      page={params.page ?? null}
    />
  )
}
