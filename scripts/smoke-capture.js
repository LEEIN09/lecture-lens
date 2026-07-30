"use strict";

const { app, BrowserWindow, desktopCapturer } = require("electron");

app.whenReady().then(async () => {
  let window;
  try {
    window = new BrowserWindow({ width: 420, height: 240, show: false });
    await window.loadURL("data:text/html,<h1>capture smoke test</h1>");
    const sources = await Promise.race([
      desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: 320, height: 180 }
      }),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("desktopCapturer timed out")), 15000))
    ]);
    const usable = sources.filter((source) => !source.thumbnail.isEmpty());
    console.log(`CAPTURE_OK sources=${sources.length} usable=${usable.length}`);
    if (!usable.length) process.exitCode = 1;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    window?.destroy();
    app.exit(process.exitCode || 0);
  }
});
