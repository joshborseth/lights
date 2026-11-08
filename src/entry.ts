import { Runtime } from 'foldkit'

import {
  Message,
  Model,
  init,
  managedResources,
  subscriptions,
  update,
} from './main'
import { startServiceWorker } from './pwa'
import { view } from './view'

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
