"""Loopback-only HTTP application; API credentials are never written to disk."""
import argparse
import getpass
import json
from pathlib import Path
import secrets
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from . import __version__
from .llm import PRESETS, resolve_config, summarize, chat_request
from .transcript import extract_transcript, parse_subtitles

WEB = Path(__file__).resolve().parent.parent / 'web'


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def create_server(host='127.0.0.1', port=4174, debug_key=''):
    if host not in ('127.0.0.1', 'localhost'):
        raise ValueError('readvideo v0.1 仅支持本机运行。')
    lock = threading.Lock()
    slots = threading.BoundedSemaphore(2)
    state = {'token': secrets.token_urlsafe(32), 'jobs': {}, 'transcripts': {}, 'debug_key': debug_key}

    def job(task):
        if not slots.acquire(blocking=False):
            raise ValueError('已有两个任务正在运行，请等待完成后重试。')
        job_id = secrets.token_urlsafe(18)
        with lock:
            expired = [key for key, value in state['jobs'].items() if value['status'] != 'running' and time.time() - value['created'] > 3600]
            for key in expired:
                state['jobs'].pop(key, None)
            if len(state['jobs']) > 40:
                for key in list(state['jobs']):
                    if state['jobs'][key]['status'] != 'running':
                        state['jobs'].pop(key)
                        break
            state['jobs'][job_id] = {'id': job_id, 'status': 'running', 'stage': '正在准备', 'progress': 5, 'created': time.time()}

        def progress(message, value):
            with lock:
                state['jobs'][job_id].update(stage=message, progress=value)

        def worker():
            try:
                result = task(progress)
                with lock:
                    state['jobs'][job_id].update(status='done', stage='已完成', progress=100, result=result)
            except ValueError as error:
                message = str(error)
                if debug_key:
                    message = message.replace(debug_key, '[redacted]')
                with lock:
                    state['jobs'][job_id].update(status='error', stage='任务未完成', error=message)
            except Exception:
                with lock:
                    state['jobs'][job_id].update(status='error', stage='任务未完成', error='处理失败，请检查输入、网络或 API 配置后重试。')
            finally:
                slots.release()
        threading.Thread(target=worker, daemon=True).start()
        return {'id': job_id}

    def store_transcript(data):
        transcript_id = secrets.token_urlsafe(18)
        with lock:
            if len(state['transcripts']) >= 20:
                state['transcripts'].pop(next(iter(state['transcripts'])))
            state['transcripts'][transcript_id] = data
        return {'transcript_id': transcript_id, **data}

    class Handler(BaseHTTPRequestHandler):
        server_version = 'readvideo'

        def log_message(self, format, *args):
            pass

        def reply(self, code, data, content_type='application/json; charset=utf-8'):
            body = json.dumps(data, ensure_ascii=False).encode('utf-8') if content_type.startswith('application/json') else data
            self.send_response(code)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'")
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def authorized(self, token=True):
            host_header = self.headers.get('Host', '')
            allowed = {'127.0.0.1:' + str(self.server.server_address[1]), 'localhost:' + str(self.server.server_address[1])}
            if host_header not in allowed:
                return False
            origin = self.headers.get('Origin')
            if origin and origin not in {'http://' + host for host in allowed}:
                return False
            return not token or secrets.compare_digest(self.headers.get('X-Readvideo-Token', ''), state['token'])

        def do_GET(self):
            path = urlsplit(self.path).path
            if not self.authorized(token=path.startswith('/api/') and path != '/api/bootstrap'):
                self.reply(403, {'error': '仅允许本机页面访问。'})
                return
            if path == '/api/bootstrap':
                self.reply(200, {'version': __version__, 'token': state['token'], 'presets': PRESETS, 'server_key_available': bool(debug_key)})
            elif path.startswith('/api/jobs/'):
                job_id = path.removeprefix('/api/jobs/')
                with lock:
                    value = dict(state['jobs'][job_id]) if job_id in state['jobs'] else None
                self.reply(200 if value else 404, value or {'error': '任务不存在或已过期，请重新开始。'})
            elif path.startswith('/api/'):
                self.reply(404, {'error': '接口不存在。'})
            else:
                files = {'/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/icon.svg': 'icon.svg'}
                if path not in files or not (WEB / files[path]).is_file():
                    self.reply(404, {'error': '页面不存在。'})
                    return
                types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml'}
                file = WEB / files[path]
                self.reply(200, file.read_bytes(), types[file.suffix])

        def do_POST(self):
            if not self.authorized():
                self.reply(403, {'error': '页面会话无效，请刷新 readvideo 后再试。'})
                return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if size <= 0 or size > 4_000_000:
                    raise ValueError('请求内容为空或过大。字幕文件请控制在 3 MB 内。')
                data = json.loads(self.rfile.read(size))
                if not isinstance(data, dict):
                    raise ValueError('请求格式无效。')
                path = urlsplit(self.path).path
                if path == '/api/extract':
                    url, language = data.get('url'), data.get('language', 'auto')
                    if not isinstance(url, str) or not url.strip() or language not in ('auto', 'zh', 'en'):
                        raise ValueError('请输入视频链接，并选择有效的字幕语言。')
                    self.reply(202, job(lambda progress: store_transcript(extract_transcript(url, language, progress))))
                elif path == '/api/import':
                    text, ext = data.get('content'), str(data.get('format', '')).lower()
                    segments = parse_subtitles(text, ext)
                    source_url = str(data.get('source_url') or '')[:4000]
                    if source_url and (urlsplit(source_url).scheme not in ('http', 'https') or not urlsplit(source_url).hostname):
                        raise ValueError('来源链接需要使用 HTTP(S)。')
                    result = {'title': str(data.get('title') or '导入字幕')[:400], 'url': source_url, 'uploader': '',
                              'duration': segments[-1]['start'], 'language': 'unknown', 'automatic': False,
                              'segments': segments, 'source': 'subtitle-file', 'available_languages': []}
                    self.reply(200, store_transcript(result))
                elif path in ('/api/generate', '/api/test'):
                    config = resolve_config(data.get('config') or {}, debug_key)
                    if path == '/api/test':
                        def test_connection(progress):
                            progress('正在测试 API 连接', 30)
                            chat_request(config, [{'role': 'user', 'content': 'Reply with OK only.'}], max_tokens=16)
                            return {'ok': True, 'model': config['model']}
                        self.reply(202, job(test_connection))
                    else:
                        transcript_id = data.get('transcript_id')
                        with lock:
                            transcript = state['transcripts'].get(transcript_id)
                        if not transcript:
                            raise ValueError('字幕已过期或尚未提取，请重新提取或导入字幕。')
                        mode, language = data.get('mode', 'brief'), data.get('language', 'zh')
                        if mode not in ('brief', 'article') or language not in ('zh', 'en'):
                            raise ValueError('请选择有效的输出形式和语言。')
                        length = data.get('length', 'medium')
                        if not isinstance(length, str) or length not in ('short', 'medium', 'long', 'detailed'):
                            raise ValueError('请选择短篇、中篇、长篇或详细。')
                        self.reply(202, job(lambda progress: summarize(transcript, config, mode, language, progress, length=length)))
                else:
                    self.reply(404, {'error': '接口不存在。'})
            except (ValueError, TypeError, KeyError, UnicodeError) as error:
                message = str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError) else '请求格式无效，请检查输入。'
                if debug_key:
                    message = message.replace(debug_key, '[redacted]')
                self.reply(400, {'error': message})
            except Exception:
                self.reply(500, {'error': '处理失败，请重试。未记录请求内容或 API Key。'})

    server = LocalServer((host, port), Handler)
    return server


def main():
    parser = argparse.ArgumentParser(description='readvideo local application')
    parser.add_argument('--port', type=int, default=4174)
    parser.add_argument('--read-key', action='store_true', help='Read an optional DeepSeek key once from stdin; keep it in memory only')
    parser.add_argument('--open-browser', action='store_true', help='Open the local page after startup')
    args = parser.parse_args()
    key = ''
    if args.read_key:
        key = getpass.getpass('DeepSeek debug key (hidden; memory only): ').strip()
    server = create_server(port=args.port, debug_key=key)
    print(f'readvideo · http://127.0.0.1:{server.server_address[1]} · memory-only key: {"available" if key else "not configured"}', flush=True)
    if args.open_browser:
        launch = threading.Timer(0.6, webbrowser.open, args=(f'http://127.0.0.1:{server.server_address[1]}/',))
        launch.daemon = True
        launch.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
