// The globals Kettu's shared code expects come first: modules there use them as they load, and
// the router loads the screens, which import them.
import './src/runtime/globals'
import './src/runtime/kettu'

import 'expo-router/entry'
