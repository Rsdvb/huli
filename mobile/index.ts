// The globals Kettu's shared code expects come first: modules there use them as they load, and
// the router loads the screens, which import them.
import './src/runtime/globals'
import './src/runtime/kettu'
// Dynamic Type caps for every Text, before any screen imports Text.
import './src/runtime/text'
// Defines the background task for silent pushes, which must exist before the app finishes launching.
import './src/push/platform'

import 'expo-router/entry'
