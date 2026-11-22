'use strict';

/**
 * Rider login: people type their e-mail address into the login form as often as their phone number,
 * so User.findByLogin accepts either. Also checks that saving a loaded user (login does this to
 * record lastLogin) leaves the stored password hash alone.
 */

const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { connectTemp, cleanup } = require('./helper');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const User = require('../../models/User');

let file;
before(async () => {
  file = await connectTemp('userlogin');
  await User.create({ name: 'Rider One', email: 'Rider.One-gt@example.com', phone: '7456886877', password: 'secret123' });
  await User.create({ name: 'Rider Two', email: 'rider-two@example.com', phone: '9876543210', password: 'another1' });
  await User.create({ name: 'Rider Three', email: 'aab@example.com', phone: '9000000002', password: 'third123' });
  await User.create({ name: 'No Email', phone: '9123456780', password: 'nomail12' });
});
after(async () => {
  await cleanup(file);
});

describe('User.findByLogin', () => {
  it('finds a user by phone number and includes the password hash', async () => {
    const user = await User.findByLogin('7456886877');
    assert.equal(user.name, 'Rider One');
    assert.equal(await user.matchPassword('secret123'), true);
  });

  it('finds a user by the e-mail exactly as stored', async () => {
    const user = await User.findByLogin('Rider.One-gt@example.com');
    assert.equal(user.phone, '7456886877');
  });

  it('finds a user by e-mail in any letter case, with dots and plus signs taken literally', async () => {
    assert.equal((await User.findByLogin('rider.one-gt@EXAMPLE.com')).phone, '7456886877');
    assert.equal((await User.findByLogin('RIDER-TWO@example.com')).phone, '9876543210');
    assert.equal(await User.findByLogin('rider-one-gt@example.com'), null, '"." is not a wildcard');
    assert.equal(await User.findByLogin('riderXone-gt@example.com'), null);
    assert.equal(await User.findByLogin('a+b@example.com'), null, '"+" is not a repeat operator');
    assert.equal(await User.findByLogin('rider.one-gt@example.co'), null, 'the whole address has to match');
  });

  it('ignores spaces around the identifier', async () => {
    assert.equal((await User.findByLogin('  7456886877 ')).name, 'Rider One');
    assert.equal((await User.findByLogin(' rider-two@example.com ')).name, 'Rider Two');
  });

  it('returns null for unknown or empty identifiers', async () => {
    for (const nothing of ['', '   ', undefined, null, '0000000000', 'nobody@example.com']) {
      assert.equal(await User.findByLogin(nothing), null, `identifier ${JSON.stringify(nothing)}`);
    }
  });

  it('does not match a user without an e-mail when an e-mail is given', async () => {
    assert.equal(await User.findByLogin('@'), null);
    assert.equal((await User.findByLogin('9123456780')).name, 'No Email');
  });
});

describe('saving a loaded user', () => {
  it('keeps the stored password hash, so the user can log in again', async () => {
    const first = await User.findByLogin('9876543210');
    const hashBefore = first.password;
    first.lastLogin = Date.now();
    await first.save();
    await new Promise((resolve) => setTimeout(resolve, 400)); // longer than a bcrypt round

    // a second save of the same instance would store a re-hashed password if the hook kept running
    first.lastLogin = Date.now();
    await first.save();
    await new Promise((resolve) => setTimeout(resolve, 400));

    const again = await User.findByLogin('9876543210');
    assert.equal(again.password, hashBefore);
    assert.equal(await again.matchPassword('another1'), true);
  });
});
