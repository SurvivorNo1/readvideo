"""Public packaging must contain only reviewed files with working local links."""
import importlib.util
from html.parser import HTMLParser
from pathlib import Path
import tempfile
import unittest
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links, self.ids = [], set()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if 'id' in attrs:
            self.ids.add(attrs['id'])
        self.links.extend(attrs[key] for key in ('src', 'href') if key in attrs)


class SiteContracts(unittest.TestCase):
    def test_public_package_has_only_reviewed_files_and_resolvable_links(self):
        spec = importlib.util.spec_from_file_location('build_site', ROOT / 'tools' / 'build_site.py')
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)
            builder.build(destination)
            files = {p.relative_to(destination).as_posix() for p in destination.rglob('*') if p.is_file()}
            self.assertEqual(files, {'.nojekyll', 'index.html', 'en.html', 'style.css', 'assets/home.png', 'assets/article.png', 'assets/icon.svg'})
            for page in ('index.html', 'en.html'):
                parsed = Links()
                parsed.feed((destination / page).read_text(encoding='utf-8'))
                for link in parsed.links:
                    url = urlsplit(link)
                    if url.scheme or url.netloc:
                        continue
                    if url.path:
                        self.assertTrue((destination / url.path).is_file(), f'{page}: missing {link}')
                    elif url.fragment:
                        self.assertIn(url.fragment, parsed.ids)


if __name__ == '__main__':
    unittest.main()
