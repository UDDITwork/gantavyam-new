'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { Database } = require('../client');

/** A stand-in for @libsql/client that records how it was asked to connect. */
function fakeClientFactory(calls) {
  return (config) => {
    calls.push(config);
    return { execute: async () => ({ rows: [] }), batch: async () => [], close() {} };
  };
}

const originalTransport = process.env.TURSO_TRANSPORT;
const originalUrl = process.env.TURSO_DATABASE_URL;
afterEach(() => {
  if (originalTransport === undefined) delete process.env.TURSO_TRANSPORT;
  else process.env.TURSO_TRANSPORT = originalTransport;
  if (originalUrl === undefined) delete process.env.TURSO_DATABASE_URL;
  else process.env.TURSO_DATABASE_URL = originalUrl;
});

describe('connection URL handling', () => {
  it('talks to Turso over HTTPS even when given a libsql:// URL', async () => {
    const calls = [];
    const db = new Database({ createClient: fakeClientFactory(calls) });
    await db.connect({ url: 'libsql://gantavyam-gantavyam.aws-ap-south-1.turso.io', authToken: 'dummy-token' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://gantavyam-gantavyam.aws-ap-south-1.turso.io');
    assert.equal(calls[0].authToken, 'dummy-token');
    assert.equal(db.url, 'https://gantavyam-gantavyam.aws-ap-south-1.turso.io');
    assert.equal(db.host, 'gantavyam-gantavyam.aws-ap-south-1.turso.io');
    assert.equal(db.readyState, 1);
    await db.disconnect();
  });

  it('keeps https:// URLs as they are', async () => {
    const calls = [];
    const db = new Database({ createClient: fakeClientFactory(calls) });
    await db.connect({ url: 'https://example-org.aws-ap-south-1.turso.io', authToken: 'dummy-token' });
    assert.equal(calls[0].url, 'https://example-org.aws-ap-south-1.turso.io');
    await db.disconnect();
  });

  it('only uses a WebSocket when it is asked for', async () => {
    process.env.TURSO_TRANSPORT = 'websocket';
    const calls = [];
    const db = new Database({ createClient: fakeClientFactory(calls) });
    await db.connect({ url: 'libsql://example-org.turso.io', authToken: 'dummy-token' });
    assert.equal(calls[0].url, 'libsql://example-org.turso.io');
    await db.disconnect();
  });

  it('leaves file: URLs alone', async () => {
    const calls = [];
    const db = new Database({ createClient: fakeClientFactory(calls) });
    const file = `file:${path.join(os.tmpdir(), 'gantavyam-url-test.db')}`;
    await db.connect({ url: file });
    assert.equal(calls[0].url, file);
    assert.equal(db.host, 'local-file');
    await db.disconnect();
  });

  it('ignores a MongoDB connection string and uses TURSO_DATABASE_URL instead', async () => {
    process.env.TURSO_DATABASE_URL = 'libsql://from-env-org.turso.io';
    const calls = [];
    const db = new Database({ createClient: fakeClientFactory(calls) });
    const warn = console.warn;
    console.warn = () => {};
    try {
      await db.connect('mongodb://localhost:27017/gantavyam');
    } finally {
      console.warn = warn;
    }
    assert.equal(calls[0].url, 'https://from-env-org.turso.io');
    await db.disconnect();
  });

  it('refuses to start without any database URL', async () => {
    delete process.env.TURSO_DATABASE_URL;
    const db = new Database({ createClient: fakeClientFactory([]) });
    await assert.rejects(db.connect({}), /No database URL given/);
  });
});
