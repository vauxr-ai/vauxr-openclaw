"""Loopback-only test harness for the unmodified, pinned Vauxr server contracts.

The control route represents the test owner/physical device. It is not production
code. Secrets remain inside this process or the client's private fixture store.
"""
import asyncio
import json
import logging
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
import traceback

HEAD = "16968a73b7610c917a9922d94d8c7ef187f7dda3"
source = Path(os.environ["VAUXR_CONTRACT_SOURCE"])
assert subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip() == HEAD
sys.path.insert(0, str(source / "src"))
from aiohttp import web
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from auth_store import CredentialStore
from owner_auth import OwnerAuth
from owner_http import OWNER, ORIGIN, PROXIES
from integration import Integration
from integration_http import INTEGRATION, integration_endpoint
from lifecycle import Lifecycle
from lifecycle_http import LIFECYCLE, lifecycle_endpoint
from enrollment import Enrollment, EnrollmentError, transcript
from enrollment_http import ENROLLMENT, enrollment_endpoint
from auth_policy import Operation, allowed

logging.disable(logging.CRITICAL)
real_time = time.time
offset = 0
time.time = lambda: real_time() + offset
root = Path(os.environ["VAUXR_CONTRACT_DATA"])
root.mkdir(parents=True, exist_ok=True)
sock = socket.socket()
sock.bind(("127.0.0.1", 0))
origin = f"http://127.0.0.1:{sock.getsockname()[1]}"
drop = None
drop_before = False

@web.middleware
async def lose_ack(request, handler):
    global drop
    if request.path == drop and drop_before:
        drop = None
        request.transport.abort()
        return web.Response(status=503)
    try:
        response = await handler(request)
    except Exception as exc:
        # Report locations and exception type, never values/private request data.
        print(type(exc).__name__ + ' ' + ' '.join(f'{Path(f.filename).name}:{f.lineno}' for f in traceback.extract_tb(exc.__traceback__)), file=sys.stderr, flush=True)
        raise
    if request.path == drop:
        drop = None
        request.transport.abort()
    return response

app = web.Application(middlewares=[lose_ack])
app[ORIGIN] = origin
app[PROXIES] = ()

def services():
    store = CredentialStore(root / "authz.json")
    app[OWNER] = OwnerAuth(store)
    app[ENROLLMENT] = Enrollment(store, origin)
    app[INTEGRATION] = Integration(store, origin)
    app[LIFECYCLE] = Lifecycle(store, origin)
    return store

store = services()
app[OWNER].initialize()
claimed = app[OWNER].claim(app[OWNER].console_claim())
app[OWNER].acknowledge(claimed["save_acknowledgement"], True)
operator_token = claimed["operator_token"]
cookie, _ = app[OWNER].login(operator_token)
del claimed
app[ENROLLMENT].initialize()

def owner():
    global cookie
    if app[OWNER].session(cookie) is None:
        cookie, _ = app[OWNER].login(operator_token)
    return app[OWNER].session(cookie)[0]

async def control(request):
    global drop, drop_before, offset, store, cookie
    body = await request.json()
    action = body["action"]
    try:
        if action in ("approve", "deny", "mismatch"):
            rows = app[INTEGRATION].execute("list", {}, owner)["requests"]
            row = next(row for row in rows if row["state"] == "pending")
            payload = {"request_id": row["request_id"]}
            if action != "deny":
                payload["user_code"] = body["code"] if action == "approve" else "00000000"
            result = app[INTEGRATION].execute("deny" if action == "deny" else "approve", payload, owner)
            return web.json_response({"state": result["state"]})
        if action in ("rotate", "revoke"):
            row = next(row for row in app[INTEGRATION].execute("list", {}, owner)["requests"] if row["state"] == "completed")
            result = app[LIFECYCLE].execute(action, {"operation_id": secrets.token_hex(16), "role": "integration", "subject": row["agent_id"]}, owner)
            return web.json_response({"state": result["state"]})
        if action == "restart":
            store = services()
            cookie, _ = app[OWNER].login(operator_token)
        elif action == "drop":
            drop = body["path"]
            drop_before = body.get("before", False)
        elif action == "clock":
            offset += body["seconds"]
        elif action == "physical":
            key = Ed25519PrivateKey.generate()
            row = app[ENROLLMENT].execute("request", {"kind": "physical", "display_name": "Fixture speaker", "public_key": key.public_key().public_bytes_raw().hex()})
            code = None
            if body.get("prove", True):
                result = app[ENROLLMENT].execute("prove", {"request_id": row["request_id"], "signature": key.sign(transcript(row, "prove")).hex()})
                code = result["code"]
            return web.json_response({"request_id": row["request_id"], "device_id": row["device_id"], "code": code})
        return web.json_response({"ok": True})
    except EnrollmentError:
        return web.json_response({"error": "fixture_operation_rejected"}, status=400)

async def policy(request):
    principal = store.authenticate(request.headers.get("Authorization", "")[7:])
    if not principal:
        return web.json_response({"error": "unauthorized"}, status=401)
    return web.json_response({op.value: allowed(principal, op) for op in Operation})

app.router.add_post("/api/integrations/v1/{action}", integration_endpoint)
app.router.add_post("/api/lifecycle/v1/{action}", lifecycle_endpoint)
app.router.add_post("/api/enrollment/v1/{action}", enrollment_endpoint)
app.router.add_post("/api/fixture/control", control)
app.router.add_post("/api/fixture/policy", policy)

async def main():
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    await web.SockSite(runner, sock).start()
    print(json.dumps({"origin": origin, "head": HEAD}), flush=True)
    await asyncio.Event().wait()

asyncio.run(main())
