// 添加电脑: pairs one more computer from a sheet; once paired, it becomes the one the app shows.

import { router } from 'expo-router'
import { useHost } from '../host'
import { LockLayer } from '../lock'
import { PairScreen } from '../screens/PairScreen'

export default function AddComputer() {
  const host = useHost()
  const close = () => {
    if (router.canGoBack()) router.back()
    else router.replace('/')
  }
  return (
    <>
      <PairScreen
        notice={null}
        onCancel={close}
        onPaired={(saved, key, paired) => {
          if (router.canDismiss()) router.dismissAll()
          void host.paired(saved, key, paired)
        }}
      />
      <LockLayer />
    </>
  )
}
