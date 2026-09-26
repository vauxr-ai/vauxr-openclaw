import assert from 'node:assert/strict';
import test from 'node:test';
import { VauxrBridge } from '../dist/src/bridge.js';
import { vauxrPlugin } from '../dist/src/channel.js';

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
      const { onAgentRunStart, ...deliveryOptions } = args.replyOptions;
      assert.equal(typeof onAgentRunStart, 'function');
      assert.deepEqual(deliveryOptions, { sourceReplyDeliveryMode: 'automatic' });
      assert.equal(args.ctx.Provider, 'vauxr');
      assert.equal(args.cfg, cfg);
    }
    assert.deepEqual(cfg, original);
  }
});

test('late message-tool progress from a retired turn cannot leak into its replacement', async () => {
  const sent = [];
  let releaseOld;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const api = {
    config: { agents: { list: [{ id: 'assistant', default: true }] } },
    logger: { info() {}, warn() {} },
    runtime: { channel: {
      session: { resolveStorePath() { return '/unused'; }, recordInboundSession() {} },
      inbound: { async run({ adapter }) { await adapter.resolveTurn().runDispatch(); } },
      reply: {
        createReplyDispatcherWithTyping() { return { dispatcher: {} }; },
        async dispatchReplyFromConfig() {
          const blocked = new Promise(resolve => { releaseOld = resolve; });
          markStarted();
          await blocked;
          await vauxrPlugin.outbound.sendText({ cfg: {}, to: 'device-1', text: 'stale progress' });
        },
      },
    } },
  };
  const bridge = new VauxrBridge(api, { url: 'http://localhost:1' });
  bridge.authenticated = true;
  bridge.ws = { readyState: 1, send(frame) { sent.push(JSON.parse(frame)); } };

  const oldDispatch = bridge.dispatchTranscript('device-1', 'old request');
  await started;
  const oldTurn = bridge.activeRuns.get('device-1');
  const replacement = { deviceId: 'device-1', protocolRunId: 'replacement', outboundSequence: 0 };
  bridge.activeRuns.set('device-1', replacement);
  releaseOld();
  await oldDispatch;

  assert.notEqual(oldTurn, replacement);
  assert.equal(bridge.activeRuns.get('device-1'), replacement);
  assert.deepEqual(sent, []);
});
