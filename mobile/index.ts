// The globals Kettu's shared code expects come first: modules there use them as they load.
import './src/runtime/globals'
import './src/runtime/kettu'

import { registerRootComponent } from 'expo'
import App from './src/App'

registerRootComponent(App)
