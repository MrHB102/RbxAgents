import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { RuntimeState } from '../shared/types'

contextBridge.exposeInMainWorld('rbx', {
  invoke: (action: string, payload: unknown) => ipcRenderer.invoke('rbx:action', action, payload),
  pathForFile: (file: File) => { try { return webUtils.getPathForFile(file) } catch { return '' } },
  onState: (callback: (state: RuntimeState) => void) => {
    const listener = (_event: unknown, state: RuntimeState) => callback(state)
    ipcRenderer.on('rbx:state', listener)
    return () => ipcRenderer.removeListener('rbx:state', listener)
  }
})
