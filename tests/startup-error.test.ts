import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MongoNetworkError, MongoParseError, MongoServerError } from 'mongodb';
import { z } from 'zod';
import { DatabaseStartupError, describeStartupError } from '../src/startup-error.js';
import { migrate } from '../src/db.js';
import type { Db } from 'mongodb';

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

test('Atlas explanations identify the actual rejected action or quota while redacting credentials and documents', () => {
  const authorization = describeStartupError(new DatabaseStartupError('creating indexes for users', new MongoServerError({
    code: 8000, message: 'user is not allowed to do action [createIndex] on [status_pulse.users]',
  })));
  assert.match(authorization, /creating indexes for users/);
  assert.match(authorization, /not allowed to do action \[createIndex\]/);
  const quota = describeStartupError(new MongoServerError({ code: 8000, message: 'you are over your space quota' }));
  assert.match(quota, /over your space quota/);
  const uri = 'mongodb+srv://private-user:hidden%40password@example.com/status_pulse';
  const privateMessage = `not authorized: private-user hidden@password hidden%40password ${uri} mongodb://other-user:other-secret@example.net/db command { token: private-document-value }`;
  const redacted = describeStartupError(new MongoServerError({ code: 8000, message: privateMessage }), uri);
  assert.match(redacted, /not authorized/);
  assert.doesNotMatch(redacted, /private-user|hidden|other-user|other-secret|example\.(com|net)|private-document-value/);
  const duplicate = describeStartupError(new MongoServerError({ code: 8000, message: 'dup key: private-document-value' }));
  assert.doesNotMatch(duplicate, /private-document-value/);
});

test('migration failures identify the collection or migration record without losing the server error', async () => {
  const serverError = new MongoServerError({ code: 8000, message: 'action not allowed' });
  const indexFailureDb = { collection: (name: string) => ({ createIndexes: async () => { if (name === 'sessions') throw serverError; } }) } as unknown as Db;
  await assert.rejects(migrate(indexFailureDb), error => error instanceof DatabaseStartupError && error.phase === 'creating indexes for sessions' && error.cause === serverError);
  const recordFailureDb = { collection: () => ({ createIndexes: async () => [], updateOne: async () => { throw serverError; } }) } as unknown as Db;
  await assert.rejects(migrate(recordFailureDb), error => error instanceof DatabaseStartupError && error.phase === 'recording migration' && error.cause === serverError);
});
