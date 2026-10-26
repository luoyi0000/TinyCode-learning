const fs = require("node:fs");
const { app } = require("electron");
const log = (m) => fs.appendFileSync("mini.log", m + "\n");
log("started electron=" + process.versions.electron + " type=" + (process.type || "none"));
app.whenReady().then(() => { log("ready"); app.quit(); });
app.on("window-all-closed", () => log("window-all-closed"));
process.on("uncaughtException", (e) => log("uncaught: " + e.message));
