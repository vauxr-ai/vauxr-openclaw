import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RealtimeConversations } from '../dist/src/realtime.js';
import { readVisibleSessionTranscriptMessageEntries } from 'openclaw/plugin-sdk/session-transcript-runtime';

test('pinned SDK bootstraps selected profile and records without dispatch, with exact session ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vauxr70-realtime-'));
  try {
    const workspace = join(root, 'workspace'); await mkdir(workspace);
    await writeFile(join(workspace, 'SOUL.md'), 'You are the selected kitchen assistant.');
    const cfg = { session: { store: join(root, 'sessions.json') }, agents: { list: [{ id: 'kitchen', workspace, default: true }] } };
    const conversations = new RealtimeConversations(cfg, 'kitchen');
    const bootstrap = await conversations.bootstrap('browser', 'session1');
    assert.match(bootstrap.instructions, /selected kitchen assistant/);
    assert.deepEqual(bootstrap.messages, []);
    const fragments = [{ id: 'u1', role: 'user', text: 'Remember the blue mug.' },
      { id: 'a1', role: 'assistant', text: 'The blue mug is', delivered: false }];
    await conversations.record('browser', 'session1', fragments);
    await conversations.record('browser', 'session1', fragments);
    const scope = conversations.scope('browser', 'session1');
    assert.equal(scope.sessionKey, 'agent:kitchen:vauxr:browser');
    const entries = await readVisibleSessionTranscriptMessageEntries(scope);
    assert.equal(entries.length, 2, 'retry must not duplicate transcript messages');
    assert.match(entries[1].message.content[0].text, /delivery unconfirmed/);
    assert.deepEqual(conversations.release('browser', 'session1'), { released: true });
    assert.throws(() => conversations.scope('browser', 'session1'), /session changed/);
    const resume = await conversations.bootstrap('browser', 'session2');
    assert.equal(resume.sessionId, bootstrap.sessionId);
    assert.equal(resume.messages.length, 2);
    assert.throws(() => conversations.scope('other-browser', 'session1'), /session changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
