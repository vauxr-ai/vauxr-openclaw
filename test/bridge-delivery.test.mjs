import assert from 'node:assert/strict';
import test from 'node:test';
import { VauxrBridge } from '../dist/src/bridge.js';

test('a retained bridge uses the current account runtime and config after restart', async () => {
  const errors = [];
  const dispatched = [];
  const retired = () => { throw new Error('agent harness host capability is no longer active'); };
  const api = {
    config: { channels: { vauxr: { targetAgent: 'stale-agent' } } },
    logger: { info() {}, warn(message) { errors.push(message); } },
    runtime: { channel: {
      session: { resolveStorePath: retired },
      inbound: { run: retired },
      reply: { dispatchReplyFromConfig: retired },
    } },
  };
  const bridge = new VauxrBridge(api, { url: 'http://localhost:1' });
  // Exercise the real start/stop lifecycle without opening a device socket.
  bridge.connect = () => {};
  bridge.subscribeAgentEvents = () => {};
  let previousLifetime;
  for (const generation of [1, 2]) {
    if (previousLifetime) previousLifetime.active = false;
    const lifetime = { active: true };
    previousLifetime = lifetime;
    const checkActive = () => { if (!lifetime.active) retired(); };
    const cfg = { channels: { vauxr: { targetAgent: `agent-${generation}` } } };
    const runtime = {
      session: {
        resolveStorePath(_store, { agentId }) {
          checkActive();
          assert.equal(agentId, `agent-${generation}`);
          return '/unused';
        },
        recordInboundSession() { checkActive(); },
      },
      inbound: { async run({ adapter }) {
        checkActive();
        const turn = adapter.resolveTurn();
        assert.equal(turn.routeSessionKey, `agent:agent-${generation}:vauxr:device-1`);
        await turn.runDispatch();
      } },
      reply: {
        createReplyDispatcherWithTyping() { checkActive(); return { dispatcher: {} }; },
        async dispatchReplyFromConfig(args) {
          checkActive();
          assert.equal(args.cfg, cfg);
          dispatched.push(generation);
        },
      },
    };
    bridge.start(runtime, cfg);
    await bridge.dispatchTranscript('device-1', 'Hello');
    bridge.stop();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(dispatched, [1, 2]);
});

test('every Vauxr transcript requests automatic delivery without changing shared config', async () => {
  for (const visibleReplies of [undefined, 'automatic', 'message_tool']) {
    const cfg = { agents: { list: [{ id: 'assistant', default: true }] },
      messages: { visibleReplies } };
    const original = structuredClone(cfg);
    const dispatched = [];
    const errors = [];
    const api = {
      config: cfg,
      logger: { info() {}, warn(message) { errors.push(message); } },
      runtime: { channel: {
        session: { resolveStorePath() { return '/unused'; }, recordInboundSession() {} },
        inbound: { async run({ channel, adapter }) {
          assert.equal(channel, 'vauxr');
          const turn = adapter.resolveTurn();
          assert.equal(turn.routeSessionKey, 'agent:assistant:vauxr:device-1');
          await turn.runDispatch();
        } },
        reply: {
          createReplyDispatcherWithTyping() { return { dispatcher: {} }; },
          async dispatchReplyFromConfig(args) { dispatched.push(args); },
        },
      } },
    };
    // TypeScript-private method is callable in emitted JS; no socket or agent run.
    // A fresh bridge also covers reconstruction after restart/session reset.
    for (let i = 0; i < 2; i++) {
      const bridge = new VauxrBridge(api, { url: 'http://localhost:1' });
      await bridge.dispatchTranscript('device-1', 'Hello');
      await bridge.dispatchTranscript('device-1', 'Hello again');
    }
    assert.deepEqual(errors, []);
    assert.equal(dispatched.length, 4);
    for (const args of dispatched) {
      assert.deepEqual(args.replyOptions, { sourceReplyDeliveryMode: 'automatic' });
      assert.equal(args.ctx.Provider, 'vauxr');
      assert.equal(args.cfg, cfg);
    }
    assert.deepEqual(cfg, original);
  }
});
