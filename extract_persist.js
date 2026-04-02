#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const leveldown = require("leveldown");

const sourceDir = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "CherryStudio",
  "Local Storage",
  "leveldb",
);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-localstorage-"));
const persistKey = Buffer.from("_file://\x00\x01persist:cherry-studio", "binary");
const outputMode = process.argv.includes("--outer") ? "outer" : "assistants";

fs.cpSync(sourceDir, tempDir, { recursive: true });
fs.rmSync(path.join(tempDir, "LOCK"), { force: true });

const db = leveldown(tempDir);

db.open({ createIfMissing: false, errorIfExists: false }, (openError) => {
  if (openError) {
    console.error(openError.message);
    process.exit(1);
  }

  db.get(persistKey, { asBuffer: true }, (getError, value) => {
    if (getError) {
      console.error(getError.message);
      process.exit(1);
    }

    try {
      const decoded = Buffer.from(value).subarray(1).toString("utf16le");
      const outer = JSON.parse(decoded);
      if (outputMode === "outer") {
        process.stdout.write(JSON.stringify(outer));
        return;
      }
      const assistants = JSON.parse(outer.assistants);
      process.stdout.write(JSON.stringify(assistants));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    } finally {
      db.close(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
      });
    }
  });
});
