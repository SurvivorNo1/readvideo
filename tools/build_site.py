"""Package only the public product pages and reviewed screenshots."""
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]


def build(destination):
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    for name in ('index.html', 'en.html', 'style.css'):
        shutil.copyfile(ROOT / 'site' / name, destination / name)
    assets = destination / 'assets'
    assets.mkdir(exist_ok=True)
    for name in ('home.png', 'article.png'):
        shutil.copyfile(ROOT / 'docs' / 'images' / name, assets / name)
    shutil.copyfile(ROOT / 'web' / 'icon.svg', assets / 'icon.svg')
    (destination / '.nojekyll').write_text('', encoding='utf-8')


if __name__ == '__main__':
    build(sys.argv[1] if len(sys.argv) > 1 else ROOT / '.qa' / 'pages')
