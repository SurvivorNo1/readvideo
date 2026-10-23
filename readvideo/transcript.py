"""Caption extraction and normalization, independent of the interface and LLM."""
import html
import ipaddress
import json
import math
import re
import socket
import tempfile
from pathlib import Path
from urllib.parse import urlsplit


def validate_video_url(url):
    if not isinstance(url, str) or len(url) > 4000:
        raise ValueError('请输入有效的视频链接。')
    parts = urlsplit(url.strip())
    if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password:
        raise ValueError('只支持不包含账号密码的 HTTP(S) 视频链接。')
    if parts.hostname.lower() in ('localhost', 'localhost.localdomain') or parts.hostname.endswith('.local'):
        raise ValueError('不支持本机或内网链接。')
    try:
        addresses = [ipaddress.ip_address(parts.hostname)]
    except ValueError:
        try:
            addresses = [ipaddress.ip_address(row[4][0]) for row in socket.getaddrinfo(parts.hostname, parts.port or (443 if parts.scheme == 'https' else 80), type=socket.SOCK_STREAM)]
        except (OSError, ValueError):
            raise ValueError('无法解析视频网址，请检查链接和网络。') from None
    if not addresses or any(not address.is_global for address in addresses):
        raise ValueError('不支持本机、内网或保留地址。')
    return url.strip()


def timestamp(seconds):
    seconds = max(0, int(float(seconds)))
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    return f'{hours:02}:{minutes:02}:{secs:02}' if hours else f'{minutes:02}:{secs:02}'


def _seconds(value):
    pieces = value.replace(',', '.').split(':')
    return sum(float(piece) * 60 ** index for index, piece in enumerate(reversed(pieces)))


def _clean(text):
    text = re.sub(r'<[^>]*>', '', str(text))
    return re.sub(r'\s+', ' ', html.unescape(text)).strip()


def parse_subtitles(text, ext):
    if not isinstance(text, str) or len(text) > 15_000_000:
        raise ValueError('字幕文件为空或过大。')
    cues = []
    try:
        if ext in ('json3', 'json'):
            data = json.loads(text)
            if isinstance(data.get('body'), list):
                cues = [(float(cue['from']), cue.get('content', '')) for cue in data['body']]
            else:
                cues = [(float(event.get('tStartMs', 0)) / 1000, ''.join(str(seg.get('utf8', '')) for seg in event.get('segs', []))) for event in data.get('events', [])]
        elif ext in ('vtt', 'srt'):
            lines = text.replace('\r\n', '\n').replace('\r', '\n').lstrip('\ufeff').split('\n')
            index = 0
            while index < len(lines):
                match = re.match(r'^\s*((?:\d+:)?\d{2}:\d{2}[.,]\d+)\s+-->\s+', lines[index])
                if not match:
                    index += 1
                    continue
                start = _seconds(match.group(1))
                index += 1
                content = []
                while index < len(lines) and lines[index].strip():
                    content.append(lines[index])
                    index += 1
                cues.append((start, ' '.join(content)))
        else:
            raise ValueError('支持 VTT、SRT、YouTube JSON3 和 Bilibili JSON 字幕。')
    except (KeyError, TypeError, AttributeError, OverflowError, json.JSONDecodeError):
        raise ValueError('字幕格式无法识别，请使用有效的 VTT 或 SRT 文件。') from None
    normalized, previous, previous_time = [], '', -100
    for start, raw in sorted(cues, key=lambda cue: cue[0]):
        content = _clean(raw)
        if not math.isfinite(start) or start < 0 or not content:
            continue
        fresh = content
        if start - previous_time <= 4:
            if content == previous or previous.endswith(' ' + content):
                fresh = ''
            elif content.startswith(previous + ' ') and previous:
                fresh = content[len(previous):].strip()
            else:
                old_words, new_words = previous.split(), content.split()
                for count in range(min(len(old_words), len(new_words)), 1, -1):
                    if old_words[-count:] == new_words[:count]:
                        fresh = ' '.join(new_words[count:])
                        break
        if fresh:
            normalized.append({'start': round(start, 3), 'text': fresh})
        previous, previous_time = content, start
    if not normalized:
        raise ValueError('没有可读取的字幕内容。可以上传 VTT/SRT 字幕再生成。')
    if sum(len(cue['text']) for cue in normalized) > 300_000:
        raise ValueError('字幕超过 30 万字符，请先拆分字幕文件。没有截断或忽略内容。')
    return normalized


def select_track(info, preferred='auto'):
    options = []
    target = preferred if preferred != 'auto' else info.get('language') or 'zh'
    for automatic, tracks in [(False, info.get('subtitles') or {}), (True, info.get('automatic_captions') or {})]:
        for language, formats in tracks.items():
            if language == 'live_chat':
                continue
            usable = [track for track in formats if track.get('ext') in ('json3', 'vtt', 'srt', 'json') and track.get('url')]
            if not usable:
                continue
            match = 0 if language == target else 1 if language.lower().startswith(target.lower() + '-') else 2 if language.startswith('zh') else 3 if language.startswith('en') else 4
            chosen = min(usable, key=lambda f: ['json3', 'vtt', 'srt', 'json'].index(f['ext']))
            options.append(((match, automatic, language), {'language': language, 'automatic': automatic, **chosen}))
    if not options:
        raise ValueError('这个视频没有可提取的字幕，或字幕需要登录。可以上传 VTT/SRT 字幕继续；本版本不会下载音频转写。')
    return min(options, key=lambda item: item[0])[1]


def chunk_segments(segments, limit=10_000):
    if limit < 40:
        raise ValueError('Chunk limit is too small.')
    chunks, current = [], ''
    for segment in segments:
        prefix = f'[{timestamp(segment["start"])}] '
        text = segment['text']
        for offset in range(0, len(text), limit - len(prefix)):
            line = prefix + text[offset:offset + limit - len(prefix)]
            if current and len(current) + 1 + len(line) > limit:
                chunks.append(current)
                current = ''
            current += ('\n' if current else '') + line
    if current:
        chunks.append(current)
    return chunks


class QuietLogger:
    def debug(self, message): pass
    def warning(self, message): pass
    def error(self, message): pass


def download_caption_text(ydl, track, headers):
    """Use yt-dlp's caption downloader, including HLS timestamp/fragment merging."""
    with tempfile.TemporaryDirectory(prefix='readvideo-captions-') as folder:
        filename = Path(folder) / ('captions.' + track['ext'])
        info = {**track, 'http_headers': dict(headers)}
        outcome = ydl.dl(str(filename), info, subtitle=True)
        successful = outcome[0] if isinstance(outcome, tuple) else outcome
        if successful is False or not filename.is_file():
            raise ValueError('字幕下载未完成，请稍后重试或导入已有字幕。')
        if filename.stat().st_size > 15_000_000:
            raise ValueError('字幕文件过大，请拆分后导入。')
        return filename.read_text(encoding='utf-8-sig')


def extract_transcript(url, language='auto', progress=None):
    from yt_dlp import YoutubeDL
    from yt_dlp.utils import DownloadError
    url = validate_video_url(url)
    if progress:
        progress('正在读取视频信息', 15)
    options = {'skip_download': True, 'noplaylist': True, 'quiet': True, 'no_warnings': True,
               'logger': QuietLogger(), 'socket_timeout': 20, 'retries': 1, 'extractor_retries': 1,
               'writesubtitles': False, 'writeautomaticsub': False, 'js_runtimes': {'node': {}},
               'noprogress': True, 'skip_unavailable_fragments': False, 'keep_fragments': False,
               'nopart': True, 'max_filesize': 15_000_000}
    try:
        with YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=False)
            if not info or info.get('_type') in ('playlist', 'multi_video'):
                raise ValueError('请粘贴单个视频的链接，暂不支持播放列表。')
            track = select_track(info, language)
            if progress:
                progress('正在提取' + ('自动' if track['automatic'] else '人工') + '字幕 · ' + track['language'], 55)
            caption_url = track['url']
            if urlsplit(caption_url).scheme not in ('http', 'https'):
                raise ValueError('字幕地址不是有效的 HTTP(S) 链接。')
            validate_video_url(caption_url)
            raw = download_caption_text(ydl, track, info.get('http_headers') or {})
            segments = parse_subtitles(raw, track['ext'])
            canonical = info.get('webpage_url') or url
            if urlsplit(canonical).scheme not in ('http', 'https'):
                canonical = url
            return {'title': str(info.get('title') or '未命名视频')[:400], 'url': canonical,
                    'uploader': str(info.get('uploader') or ''), 'duration': info.get('duration'),
                    'language': track['language'], 'automatic': track['automatic'], 'segments': segments,
                    'source': 'yt-dlp', 'available_languages': sorted(set((info.get('subtitles') or {}).keys()) | set((info.get('automatic_captions') or {}).keys()))[:200]}
    except ValueError:
        raise
    except DownloadError as error:
        message = str(error).lower()
        if any(term in message for term in ('429', 'sign in', 'login', 'cookies', 'bot', '403')):
            raise ValueError('视频平台限制了访问，可能需要登录或稍后再试。也可以导入已有字幕；应用不会自动读取浏览器账号。') from None
        raise ValueError('未能读取视频。请检查链接、网络和 yt-dlp 版本，或导入已有字幕。') from None
    except Exception:
        raise ValueError('字幕提取失败，请检查网络，或上传 VTT/SRT 字幕继续。') from None
