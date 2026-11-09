import { Runtime } from 'foldkit'

import { registerHouseSceneElement } from './houseElement'
import {
  Message,
  Model,
  init,
  managedResources,
  subscriptions,
  update,
} from './main'
import { startInstalledAppHeight, startServiceWorker } from './pwa'
import { registerSheetGrabberElement } from './sheetGrabber'
import { view } from './view'

startInstalledAppHeight()
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

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  startServiceWorker(navigator.serviceWorker)
}
