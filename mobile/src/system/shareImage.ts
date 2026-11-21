// A picture the phone was given as a data URI, such as a sign-in's QR code, handed to the system:
// the share sheet on iOS, whose Save Image puts it in Photos and whose AirDrop or apps send it to
// another device; on Android, where React Native shares text alone, the app that opens images.

import { Platform, Share } from 'react-native'
import { File, Paths } from 'expo-file-system'

const TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
}

/** Writes the picture into the cache under `name` and offers it; resolves once offered. */
export async function shareImage(dataUri: string, name: string): Promise<void> {
  const match = /^data:([^;]+);base64,(.*)$/.exec(dataUri)
  if (!match) throw new Error('这张图片不能保存。')
  const type = match[1]!
  const file = new File(Paths.cache, `${name.replace(/[\\/:*?"<>|]/g, '')}.${TYPES[type] ?? 'png'}`)
  const binary = atob(match[2]!)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  file.create({ overwrite: true })
  await file.write(bytes)
  if (Platform.OS === 'ios') {
    await Share.share({ url: file.uri })
    return
  }
  await file.preview({ title: name, mimeType: type })
}
