import { Runtime } from 'foldkit'

import { reloadOnNewBuild } from './freshBuild'
import { registerHouseSceneElement } from './houseElement'
import {
  Message,
  Model,
  init,
  managedResources,
  subscriptions,
  update,
} from './main'
import { startServiceWorker } from './pwa'
import { registerSheetGrabberElement } from './sheetGrabber'
import { view } from './view'

registerHouseSceneElement()
registerSheetGrabberElement()

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  subscriptions,
  managedResources,
  container: document.getElementById('root'),
  devTools: {
    Message,
  },
})

Runtime.run(application)

if (import.meta.env.PROD) {
  reloadOnNewBuild()
  if ('serviceWorker' in navigator) {
    startServiceWorker(navigator.serviceWorker)
  }
}
