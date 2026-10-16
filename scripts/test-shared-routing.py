#!/usr/bin/env python3
"""Exercise the real shared Caddy config and built Strava UI on an isolated network."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
STUB = '''import os,json
from http.server import BaseHTTPRequestHandler,HTTPServer
class Handler(BaseHTTPRequestHandler):
 def do_GET(self): self.reply()
 def do_POST(self): self.reply()
 def reply(self):
  body=self.rfile.read(int(self.headers.get('Content-Length',0))).decode()
  data=json.dumps(dict(service=os.environ['ROLE'],path=self.path,method=self.command,body=body)).encode()
  self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(data)
 def log_message(self,*args): pass
HTTPServer(('0.0.0.0',int(os.environ['PORT'])),Handler).serve_forever()
'''

with tempfile.TemporaryDirectory(prefix='strava-routing-') as tmp:
    folder = Path(tmp)
    (folder/'stub.py').write_text(STUB)
    services = {}
    for name, port in [('api',8000),('personal-portfolio-app',3000),('personal-portfolio-backend',8000)]:
        services[name] = {'image':os.getenv('ROUTING_TEST_PYTHON_IMAGE','python:3.12-alpine'),
            'entrypoint':['python','/stub.py'],'environment':{'ROLE':name,'PORT':str(port)},
            'volumes':[f'{folder}/stub.py:/stub.py:ro']}
    services['frontend'] = {'build':{'context':str(ROOT/'frontend'),
        'args':{'VITE_BASE_PATH':'/strava/','VITE_API_BASE':'/strava'}},
        'image':os.getenv('ROUTING_TEST_FRONTEND_IMAGE','strava-auto-frontend:routing-test')}
    services['caddy'] = {'image':'caddy:2-alpine','environment':{'DOMAIN':':80'},
        'volumes':[f'{ROOT}/Caddyfile.portfolio:/etc/caddy/Caddyfile:ro'],
        'tmpfs':['/data','/config'],'ports':['127.0.0.1::80']}
    config=folder/'compose.json';config.write_text(json.dumps({'services':services}))
    compose=['docker','compose','-p','strava-routing-'+uuid.uuid4().hex[:8],'-f',str(config)]
    def run(*args,**kwargs): return subprocess.check_output(compose+list(args),text=True,**kwargs)
    try:
        subprocess.run(['docker','build','--build-arg','VITE_BASE_PATH=/strava/',
            '--build-arg','VITE_API_BASE=/strava','-t',services['frontend']['image'],
            str(ROOT/'frontend')],check=True)
        run('up','-d','--no-build','--wait')
        base='http://'+run('port','caddy','80').strip()
        for attempt in range(40):
            try:
                with urllib.request.urlopen(base+'/',timeout=3) as response:
                    assert json.load(response)['service']=='personal-portfolio-app'
                break
            except Exception:
                if attempt==39: raise
                time.sleep(1)
        cases=[('/','personal-portfolio-app','/'),
            ('/api/auth/get-session','personal-portfolio-app','/api/auth/get-session'),
            ('/api/transactions','personal-portfolio-app','/api/transactions'),
            ('/api/health','personal-portfolio-backend','/api/health'),
            ('/healthz','api','/healthz'),
            ('/api/webhooks/strava?hub.challenge=test','api','/api/webhooks/strava?hub.challenge=test'),
            ('/api/auth/strava/callback?code=test','api','/api/auth/strava/callback?code=test'),
            ('/strava/api/session','api','/api/session')]
        for route, service, upstream_path in cases:
            with urllib.request.urlopen(base+route) as response: result=json.load(response)
            assert result['service']==service and result['path']==upstream_path,(route,result)
        payload=b'{"test":"routing-only"}'
        for route in ['/api/webhooks/strava','/strava/api/logout']:
            with urllib.request.urlopen(urllib.request.Request(base+route,data=payload)) as response: result=json.load(response)
            assert result['service']=='api' and result['method']=='POST' and result['body']==payload.decode()
        with urllib.request.urlopen(base+'/strava') as response:
            assert response.url.endswith('/strava/')
            html=response.read().decode()
        assets=re.findall(r'(?:src|href)="(/strava/[^\"]+)"',html)
        assert any('/assets/' in item for item in assets),html
        for asset in assets:
            with urllib.request.urlopen(base+asset) as response:
                assert response.status==200
                if asset.endswith('.js'):
                    assert not response.headers.get('Content-Type','').startswith('text/html')
                    assert '"/strava"' in response.read().decode()
        print(f'PASS: {len(cases)} routes, webhook/API POST bodies, slash redirect, and {len(assets)} prefixed assets')
    finally:
        run('down','--remove-orphans')
