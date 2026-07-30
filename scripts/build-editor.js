"use strict";

const path = require("node:path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
esbuild.buildSync({
  absWorkingDir: root,
  entryPoints: [path.join(root, "src", "editor-entry.js")],
  outfile: path.join(root, "src", "editor-bundle.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  logLevel: "info"
});
