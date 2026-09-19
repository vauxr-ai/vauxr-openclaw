"""Disposable process exercising production AgentServer and persisted credentials."""
import asyncio
import json
import os
import sys
from pathlib import Path

source = Path(os.environ['VAUXR_RESTART_SOURCE'])
sys.path.insert(0, str(source / 'src'))
from aiohttp import web
import agent_registry
from agent_server import AgentServer
from auth import get_store
from auth_policy import Role
from auth_store import Credential, verifier
from lifecycle import Lifecycle

TOKEN = 'vx_int_' + 'A' * 43  # Local fixture authority only.


async def main():
    agent_registry.load()
    if agent_registry.get_active() is None:
        agent, _ = await agent_registry.create('Restart fixture', 'openclaw')
        get_store().replace((Credential('restart-fixture', Role.INTEGRATION, agent.id, verifier(TOKEN)),))
        agent_registry.activate(agent.id)
    agent = agent_registry.get_active()
    bridge = AgentServer()
    app = web.Application()

    async def agent_socket(request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await bridge.handle_connection(ws)
        return ws

    async def poll(request):
        token = request.headers.get('Authorization', '')[7:]
        lifecycle = Lifecycle(get_store(), f'http://{request.host}')
        return web.json_response(lifecycle.execute('poll', await request.json(),
            lambda: get_store().authenticate(token)))

    app.router.add_get('/agent', agent_socket)
    app.router.add_post('/api/lifecycle/v1/poll', poll)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', int(os.environ.get('RESTART_PORT', '0')))
    await site.start()
    print(json.dumps({'port': site._server.sockets[0].getsockname()[1], 'subject': agent.id}), flush=True)
    await asyncio.Event().wait()


asyncio.run(main())
