import { contextBridge, ipcRenderer } from 'electron'
import type { RuntimeState } from '../shared/types'

contextBridge.exposeInMainWorld('rbx', {
  invoke: (action: string, payload: unknown) => ipcRenderer.invoke('rbx:action', action, payload),
  onState: (callback: (state: RuntimeState) => void) => {
    const listener = (_event: unknown, state: RuntimeState) => callback(state)
    ipcRenderer.on('rbx:state', listener)
    return () => ipcRenderer.removeListener('rbx:state', listener)
  }
})
