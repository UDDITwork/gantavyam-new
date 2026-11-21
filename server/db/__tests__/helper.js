'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('..');

/** Connects the layer to a throw-away SQLite file (each test file runs in its own process). */
async function connectTemp(name) {
  const file = path.join(os.tmpdir(), `gantavyam-test-${name}-${process.pid}-${Date.now()}.db`);
  await mongoose.connect({ url: `file:${file}` });
  return file;
}

async function cleanup(file) {
  await mongoose.disconnect();
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      fs.unlinkSync(file + suffix);
    } catch (e) {
      // the file may still be locked on Windows; temp files are harmless
    }
  }
}

module.exports = { mongoose, connectTemp, cleanup };
