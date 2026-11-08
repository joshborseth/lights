// Hot-loads extension/presets.mjs into the running Zigbee2MQTT. No restart, and no commands reach the bulbs.
import { readFileSync } from 'node:fs'

const code = readFileSync(
  new URL('../extension/presets.mjs', import.meta.url),
  'utf8',
)
const socket = new WebSocket('ws://127.0.0.1:8080/api')
const fail = reason => {
  console.error(`Extension deploy failed: ${reason}`)
  process.exit(1)
}
setTimeout(() => fail('timed out'), 20_000)
socket.onerror = () => fail('could not reach Zigbee2MQTT')
socket.onopen = () => {
  socket.send(
    JSON.stringify({
      topic: 'bridge/request/extension/save',
      payload: { name: 'presets.mjs', code },
    }),
  )
}
socket.onmessage = event => {
  const { topic, payload } = JSON.parse(event.data)
  if (topic !== 'bridge/response/extension/save') {
    return
  }
  if (payload.status !== 'ok') {
    fail(payload.error)
  }
  console.log('Extension loaded.')
  process.exit(0)
}
