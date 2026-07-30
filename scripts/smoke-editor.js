"use strict";

const { app, BrowserWindow } = require("electron");
const path = require("node:path");

async function run() {
  const root = path.resolve(__dirname, "..");
  const errors = [];
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(root, "src", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window.webContents.on("console-message", (_event, details) => {
    if (details.level === "error") errors.push(details.message);
  });
  await window.loadFile(path.join(root, "src", "index.html"));
  const result = await window.webContents.executeJavaScript(`({
    editor: Boolean(document.querySelector("#codeEditor .cm-editor")),
    lineNumbers: Boolean(document.querySelector("#codeEditor .cm-gutters")),
    rawTab: Boolean(document.querySelector('[data-tab="raw"]')),
    diffTab: Boolean(document.querySelector('[data-tab="diff"]'))
  })`);
  if (errors.length || !Object.values(result).every(Boolean)) {
    throw new Error(`EDITOR_SMOKE_FAILED ${JSON.stringify({ result, errors })}`);
  }
  console.log(`EDITOR_SMOKE_OK ${JSON.stringify(result)}`);
  window.destroy();
}

app.whenReady()
  .then(run)
  .then(() => app.quit())
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
