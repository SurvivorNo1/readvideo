"""Opt-in live extractor smoke test. Saves local evidence under ignored .qa/."""
from pathlib import Path
import json
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from readvideo.transcript import extract_transcript

if __name__ == '__main__':
    url = sys.argv[1] if len(sys.argv) > 1 else 'https://www.ted.com/talks/derek_sivers_how_to_start_a_movement'
    try:
        result = extract_transcript(url, 'auto', lambda message, value: print(message, flush=True))
        target = Path(__file__).resolve().parents[1] / '.qa' / 'live-transcript.json'
        target.parent.mkdir(exist_ok=True)
        target.write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
        print(json.dumps({'title': result['title'], 'segments': len(result['segments']), 'language': result['language'], 'automatic': result['automatic'], 'source': result['source']}, ensure_ascii=True))
    except ValueError as error:
        print(str(error))
        raise SystemExit(1)
