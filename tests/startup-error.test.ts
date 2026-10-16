import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MongoNetworkError, MongoParseError, MongoServerError } from 'mongodb';
import { z } from 'zod';
import { DatabaseStartupError, describeStartupError } from '../src/startup-error.js';

test('startup diagnostics distinguish authentication from authorization and retain the failing phase', () => {
  const authentication = describeStartupError(new DatabaseStartupError('connecting', new MongoServerError({ code: 18, message: 'Authentication failed' })));
  assert.match(authentication, /code=18 during connecting/);
  assert.match(authentication, /Authentication failed.*MONGODB_URI.*authSource=admin/);
  const authorization = describeStartupError(new DatabaseStartupError('creating indexes', new MongoServerError({ code: 13, message: 'not authorized' })));
  assert.match(authorization, /code=13 during creating indexes/);
  assert.match(authorization, /permission denied.*MONGODB_DATABASE.*readWrite/);
});

test('Atlas generic error code is classified as authentication only when its message identifies it', () => {
  const auth = describeStartupError(new MongoServerError({ code: 8000, message: 'bad auth : authentication failed' }));
  assert.match(auth, /Authentication failed/);
  const other = describeStartupError(new MongoServerError({ code: 8000, message: 'atlas quota exceeded' }));
  assert.match(other, /code=8000/);
  assert.doesNotMatch(other, /Authentication failed/);
});

test('startup diagnostics distinguish index conflicts and duplicate records', () => {
  for (const code of [85, 86]) {
    assert.match(describeStartupError(new MongoServerError({ code, message: 'index failure' })), /existing index conflicts/);
  }
  assert.match(describeStartupError(new MongoServerError({ code: 11000, message: 'duplicate key' })), /Existing data conflicts with a unique index/);
});

test('startup diagnostics never print raw messages, connection credentials, document values, or validation input', () => {
  const secret = 'do-not-log-this-secret';
  const raw = `mongodb://user:${secret}@example.com/database?value=${secret}`;
  const parsed = z.literal('production').safeParse(raw);
  assert.equal(parsed.success, false);
  const errors = [
    new MongoServerError({ code: 18, message: raw }),
    new MongoServerError({ code: 11000, message: raw, keyValue: { email: secret } }),
    new MongoServerError({ code: 99999, message: raw }),
    new MongoParseError(raw),
    new MongoNetworkError(raw),
    new Error(raw),
    parsed.error,
    raw,
    null,
  ];
  for (const error of errors) {
    for (const input of [error, new DatabaseStartupError('connecting', error)]) {
      const diagnostic = describeStartupError(input);
      assert.doesNotMatch(diagnostic, /do-not-log-this-secret|mongodb:\/\/|example\.com/);
      assert.ok(diagnostic.length > 20);
    }
  }
});
