"""Deterministic browser fixture; never used by app.py or live smoke tests."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from unittest.mock import patch
from readvideo.server import create_server


def extract(url, language, progress):
    progress('测试夹具：读取字幕', 60)
    if 'no-captions' in url:
        raise ValueError('这个视频没有可提取的字幕。可以导入字幕继续。')
    return {'title':'如何更好地阅读一篇论文', 'url':'https://www.youtube.com/watch?v=fixture', 'uploader':'UI test fixture', 'duration':180,
            'language':'zh', 'automatic':False, 'source':'yt-dlp', 'available_languages':['zh','en'],
            'segments':[{'start':0,'text':'阅读一篇论文，先明确你希望解决的问题。'}, {'start':35,'text':'先读摘要和结论，再看图表，最后阅读方法和实验。'}, {'start':92,'text':'记录作者的假设和证据，不要只记住结论。'}]}


def generate(transcript, config, mode, language, progress, *, length='medium'):
    progress('测试夹具：生成内容', 70)
    return {'markdown':'# 让论文阅读有的放矢\n\n先带着问题阅读，再沿着作者的证据链理解结论。\n\n## 先建立全局视角\n\n从摘要与结论入手，利用图表理解文章的核心贡献。[00:35]\n\n## 留下可以复核的笔记\n\n记录假设、证据与限制，避免把作者的结论当成没有条件的事实。[01:32]\n\n<script>window.fixtureInjection=true</script>', 'mode':mode,'length':length if mode == 'article' else None,'language':language,'model':config['model'],'chunks':1}


with patch('readvideo.server.extract_transcript', side_effect=extract), patch('readvideo.server.summarize', side_effect=generate), patch('readvideo.server.chat_request', return_value='OK'):
    server=create_server(port=4184,debug_key='fixture-key-not-real')
    print('Browser fixture server ready',flush=True)
    server.serve_forever()
