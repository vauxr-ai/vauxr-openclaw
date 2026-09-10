import assert from 'node:assert/strict';
import test from 'node:test';
import entry from '../dist/index.js';
import { vauxrPlugin } from '../dist/src/channel.js';
import { DEFAULT_VOICE_SYSTEM_PROMPT } from '../dist/src/defaults.js';
import { buildVoicePromptContext, isVauxrTurn, VAUXR_REPLY_ROUTING_GUIDANCE as guidance } from '../dist/src/reply-routing.js';

test('legacy and current bridge keys; reject embedded lookalikes and child sessions', () => {
  for (const sessionKey of ['vauxr:device-1', 'agent:assistant:vauxr:device-1'])
    assert.equal(isVauxrTurn({ sessionKey }), true, sessionKey);
  for (const sessionKey of [undefined, '', 'vauxr:', 'agent:a:webchat:x', 'agent:a:slack:vauxr:x', 'prefix:vauxr:x', 'agent:a:vauxr:x:subagent:y'])
    assert.equal(isVauxrTurn({ sessionKey }), false, sessionKey);
});

test('authoritative channel wins; support channel context without a bridge key', () => {
  assert.equal(isVauxrTurn({ channel: 'vauxr' }), true);
  assert.equal(isVauxrTurn({ messageProvider: 'vauxr' }), true);
  assert.equal(isVauxrTurn({ channel: 'webchat', sessionKey: 'vauxr:x' }), false);
  assert.equal(isVauxrTurn({ messageProvider: 'slack', sessionKey: 'vauxr:x' }), false);
});

test('custom and empty style prompts cannot remove shared routing guidance', () => {
  for (const custom of [undefined, '', 'Speak briefly.', 'Use message/send for everything.']) {
    const result = buildVoicePromptContext({ sessionKey: 'vauxr:x' }, custom).appendSystemContext;
    assert.ok(result.endsWith(guidance));
    if (custom === undefined) assert.ok(result.startsWith(DEFAULT_VOICE_SYSTEM_PROMPT));
    else if (custom) assert.ok(result.startsWith(custom));
    else assert.equal(result, guidance);
  }
  assert.equal(buildVoicePromptContext({ channel: 'slack' }, 'custom'), undefined);
});

test('guidance distinguishes automatic delivery, private finals, and explicit outbound requests', () => {
  for (const clause of ['normal final assistant reply', 'Do not call message/send', 'or vauxr_announce',
    'message_tool_only', 'finals stay private', 'follow that policy instead',
    'Separate outbound messages remain available when explicitly requested',
    'do not work around it', 'Preserve all tool permissions and consent'])
    assert.ok(guidance.includes(clause), clause);
});

test('channel adapter exposes the same static transport hints, independently of voice style', () => {
  assert.deepEqual(vauxrPlugin.agentPrompt.messageToolHints({ cfg: {} }), [guidance]);
  assert.deepEqual(vauxrPlugin.agentPrompt.messageToolHints({ cfg: { channels: { vauxr: { voiceSystemPrompt: '' } } } }), [guidance]);
});

test('registered hook rebuilds every turn/reset and leaves consent and unrelated turns untouched', () => {
  for (const consent of [true, false]) {
    const hooks = new Map();
    const warnings = [];
    const tools = [];
    const config = { plugins: { entries: { vauxr: { hooks: { allowConversationAccess: consent } } } } };
    const before = structuredClone(config);
    try {
      entry.register({
        registrationMode: 'full', config,
        pluginConfig: { url: 'http://127.0.0.1:1', voiceSystemPrompt: 'Custom style.' },
        registerChannel() {}, registerTool(tool) { tools.push(tool); },
        on(name, hook) { hooks.set(name, hook); },
        logger: { warn(msg) { warnings.push(msg); } },
      });
      const hook = hooks.get('before_prompt_build');
      for (const sessionId of ['before-reset', 'after-reset']) {
        const result = hook({ prompt: 'hello', messages: [] }, { sessionKey: 'agent:a:vauxr:d', sessionId });
        assert.equal(result.appendSystemContext, 'Custom style.\n\n' + guidance);
      }
      assert.equal(hook({}, { sessionKey: 'agent:a:webchat:d' }), undefined);
      assert.deepEqual(config, before);
      assert.equal(warnings.length, consent ? 0 : 1);
      assert.match(tools.find(t => t.name === 'vauxr_announce').description, /explicitly requests/);
    } finally {
      delete globalThis.__vauxrBridge;
    }
  }
  // This mock checks registration, not host enforcement of hook consent.
});
