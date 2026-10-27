"""Panel API istemcisi (docs/agent-api.md)."""
import json
import os
import ssl
import urllib.error
import urllib.parse
import urllib.request

from . import VERSION


class ApiError(Exception):
    def __init__(self, status, code, message=""):
        super().__init__(f"HTTP {status} {code} {message}".strip())
        self.status = status
        self.code = code


class Api:
    def __init__(self, server_url, rig_id=None, secret=None, timeout=15):
        self.base = server_url.rstrip("/") + "/api/agent/v1"
        self.rig_id = rig_id
        self.secret = secret
        self.timeout = timeout
        parsed = urllib.parse.urlparse(self.base)
        local = parsed.hostname in ("localhost", "127.0.0.1", "::1")
        # Gerçek kullanımda sadece HTTPS; düz HTTP yalnızca yerel geliştirmede
        if parsed.scheme != "https" and not (local or os.environ.get("WM_INSECURE_DEV") == "1"):
            raise ValueError("SERVER_URL https:// ile başlamalı")
        self.ctx = ssl.create_default_context() if parsed.scheme == "https" else None

    def set_credentials(self, rig_id, secret):
        self.rig_id, self.secret = rig_id, secret

    def request(self, method, path, body=None):
        headers = {"accept": "application/json", "user-agent": f"whisperagent/{VERSION}"}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["content-type"] = "application/json"
        if self.rig_id and self.secret:
            headers["authorization"] = f"Bearer {self.rig_id}.{self.secret}"
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout, context=self.ctx) as res:
                raw = res.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            try:
                payload = json.loads(e.read() or b"{}")
            except ValueError:
                payload = {}
            raise ApiError(e.code, payload.get("error", "http_error"), payload.get("message", "")) from None

    # Uç noktalar
    def register(self, fingerprint, hostname, os_info):
        return self.request("POST", "/register", {"hw_fingerprint": fingerprint, "hostname": hostname,
                                                   "agent_version": VERSION, "os_info": os_info})

    def status(self):
        return self.request("GET", "/status")

    def hardware(self, payload):
        return self.request("PUT", "/hardware", payload)

    def stats(self, payload):
        return self.request("POST", "/stats", payload)

    def config(self):
        return self.request("GET", "/config")

    def commands(self):
        return self.request("GET", "/commands").get("commands", [])

    def command_result(self, cmd_id, status, exit_code, output):
        return self.request("POST", f"/commands/{int(cmd_id)}/result",
                            # Otomatik OC sonucu kart kart JSON: 8+ kartta 4000 karakteri aşar, kesilirse panel okuyamaz.
                            # Sunucu komut türüne göre kendi sınırını uygular (konsol 12 KB, otomatik OC 100 KB).
                            {"status": status, "exit_code": exit_code, "output": str(output)[:100000]})

    def update(self, channel="stable"):
        q = urllib.parse.urlencode({"version": VERSION, "channel": channel})
        return self.request("GET", f"/update?{q}")
