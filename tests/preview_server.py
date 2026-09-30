"""Local UI preview with explicitly simulated Chrome APIs and Bluetooth."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import os

os.chdir(Path(__file__).resolve().parent.parent)

class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/preview.html':
            html = Path('control.html').read_text(encoding='utf-8').replace(
                '<script src="core.js">', '<script src="tests/browser-mock.js"></script><script src="core.js">')
            html = html.replace('<body>', '<body><div style="position:fixed;top:0;left:0;z-index:99999;background:#702;color:white;padding:4px">UI 验证预览 · API/蓝牙均为模拟</div>')
            data = html.encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            super().do_GET()

ThreadingHTTPServer(('127.0.0.1', 8765), Handler).serve_forever()
