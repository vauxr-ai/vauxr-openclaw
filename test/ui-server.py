"""Disposable production HTTP/WS app for the cross-language settings test."""
import asyncio
import json
import os
import socket
import signal
import sys
from pathlib import Path

source = Path(os.environ['VAUXR_UI_SOURCE'])
sys.path[:0] = [str(source / 'src'), str(source)]
from aiohttp import web
from tests.auth_helpers import create_agent, seed
from vauxr.agents import registry
from vauxr.auth.policy import Role
from vauxr.auth.service import get_store
from vauxr.web.owner import OWNER, LAN_COOKIE
from vauxr.server import make_app


async def main():
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.setblocking(False)
    origin = f'http://127.0.0.1:{listener.getsockname()[1]}'
    os.environ['OWNER_HTTP_ORIGIN'] = origin
    os.environ.pop('OWNER_HTTPS_ORIGIN', None)
    os.environ.pop('OWNER_TRUSTED_PROXIES', None)
    agent, _ = await create_agent('Household')
    registry.activate(agent.id)
    seed('fixture-integration', Role.INTEGRATION, agent.id)
    seed('fixture-browser', Role.DEVICE, 'B1')
    from vauxr.provisioning.lifecycle_schema import empty_state
    get_store().lifecycle = empty_state()
    get_store().lifecycle['bindings']['B1'] = {'kind': 'browser', 'public_key': 'ab' * 32}
    get_store().replace(get_store().records)
    app = make_app()
    owner = app[OWNER]
    owner.initialize()
    claimed = owner.claim(owner.console_claim())
    owner.acknowledge(claimed['save_acknowledgement'], True)
    cookie, session = owner.login(claimed['operator_token'])
    headers = {'Origin': origin, 'Cookie': f'{LAN_COOKIE}={cookie}', 'X-CSRF-Token': session.csrf,
               'X-Vauxr-Browser': 'fixture-browser', 'Content-Type': 'application/json'}
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    await web.SockSite(runner, listener).start()
    print(json.dumps({'origin': origin, 'subject': agent.id, 'headers': headers}), flush=True)
    stop = asyncio.Event()
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, stop.set)
    try:
        await stop.wait()
    finally:
        await runner.cleanup()
        listener.close()


asyncio.run(main())
