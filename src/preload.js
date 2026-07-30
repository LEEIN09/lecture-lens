"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lectureLens", {
  listSources: () => ipcRenderer.invoke("capture:list"),
  captureFrame: (sourceId) => ipcRenderer.invoke("capture:frame", sourceId),
  recognize: (dataUrl) => ipcRenderer.invoke("ocr:recognize", dataUrl),
  chooseWorkspace: () => ipcRenderer.invoke("workspace:choose"),
  readTarget: (workspacePath, relativePath) =>
    ipcRenderer.invoke("file:read", workspacePath, relativePath),
  writeTarget: (payload) => ipcRenderer.invoke("file:write", payload),
  evaluateFrameSafety: (stats) => ipcRenderer.invoke("analysis:frame-safety", stats),
  evaluateCodeSafety: (payload) => ipcRenderer.invoke("analysis:code-safety", payload),
  calculateCropRegion: (payload) => ipcRenderer.invoke("analysis:crop-region", payload),
  mergeIncrementalCode: (payload) => ipcRenderer.invoke("analysis:incremental-merge", payload),
  onOcrProgress: (listener) => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("ocr:progress", handler);
    return () => ipcRenderer.removeListener("ocr:progress", handler);
  }
});
