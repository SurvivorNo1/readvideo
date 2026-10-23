import unittest
from unittest.mock import patch
from readvideo.transcript import parse_subtitles, select_track, chunk_segments, timestamp, validate_video_url, download_caption_text


class SubtitleContracts(unittest.TestCase):
    def test_vtt_preserves_time_and_cleans_markup(self):
        text = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<c>Hello &amp; welcome</c>\n\n00:00:04.000 --> 00:00:06.000\nNext idea.\n'
        self.assertEqual(parse_subtitles(text, 'vtt'), [{'start': 1.0, 'text': 'Hello & welcome'}, {'start': 4.0, 'text': 'Next idea.'}])

    def test_srt_accepts_comma_timestamps_and_multiline_text(self):
        text = '1\n00:01:02,500 --> 00:01:05,000\nFirst line\nsecond line\n'
        self.assertEqual(parse_subtitles(text, 'srt'), [{'start': 62.5, 'text': 'First line second line'}])

    def test_json3_keeps_real_words_and_skips_empty_events(self):
        text = '{"events":[{"tStartMs":1200,"segs":[{"utf8":"Hello "},{"utf8":"world"}]},{"tStartMs":2000}]}'
        self.assertEqual(parse_subtitles(text,'json3'),[{'start':1.2,'text':'Hello world'}])

    def test_bilibili_json(self):
        self.assertEqual(parse_subtitles('{"body":[{"from":3.5,"to":5,"content":"你好"}]}','json'),[{'start':3.5,'text':'你好'}])

    def test_rolling_captions_do_not_repeat_the_same_sentence(self):
        text = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello world\n\n00:00:02.000 --> 00:00:04.000\nHello world\nToday we learn.\n\n00:00:04.000 --> 00:00:06.000\nToday we learn.\n'
        self.assertEqual(' '.join(s['text'] for s in parse_subtitles(text,'vtt')), 'Hello world Today we learn.')

    def test_non_adjacent_repetition_is_not_erased(self):
        text = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nYes\n\n00:00:02.000 --> 00:00:03.000\nDifferent idea\n\n00:00:04.000 --> 00:00:05.000\nYes\n'
        self.assertEqual([s['text'] for s in parse_subtitles(text,'vtt')], ['Yes','Different idea','Yes'])

    def test_empty_or_invalid_subtitles_fail_instead_of_fabricating_text(self):
        for text,ext in [('WEBVTT\n','vtt'),('not subtitles','srt'),('{}','json3')]:
            with self.assertRaises(ValueError): parse_subtitles(text,ext)

    def test_language_preference_wins_before_manual_vs_auto(self):
        info={'language':'en','subtitles':{'en':[{'ext':'vtt','url':'https://example.com/en'}]},'automatic_captions':{'zh-Hans':[{'ext':'json3','url':'https://example.com/zh'}]}}
        self.assertEqual(select_track(info,'zh')['language'],'zh-Hans')
        self.assertTrue(select_track(info,'zh')['automatic'])

    def test_authored_subtitles_win_for_matching_language(self):
        info={'language':'en','subtitles':{'en':[{'ext':'vtt','url':'https://example.com/manual'}]},'automatic_captions':{'en':[{'ext':'vtt','url':'https://example.com/auto'}]}}
        self.assertFalse(select_track(info,'auto')['automatic'])

    def test_missing_subtitles_is_explicit(self):
        with self.assertRaisesRegex(ValueError,'字幕'): select_track({'subtitles':{},'automatic_captions':{}},'auto')

    def test_chunks_preserve_all_content_and_respect_limits(self):
        segments=[{'start':i*2,'text':'chapter '+str(i)+' '+'x'*55} for i in range(20)]
        chunks=chunk_segments(segments,limit=200)
        self.assertGreater(len(chunks),1)
        self.assertTrue(all(len(chunk)<=200 for chunk in chunks))
        for segment in segments: self.assertIn(segment['text'],'\n'.join(chunks))

    def test_a_single_long_cue_is_split_without_losing_characters(self):
        chunks=chunk_segments([{'start':0,'text':'界'*1000}],limit=200)
        self.assertTrue(all(len(chunk)<=200 for chunk in chunks))
        self.assertEqual(''.join(chunks).count('界'),1000)

    def test_time_format_handles_hour_long_videos(self):
        self.assertEqual(timestamp(65),'01:05')
        self.assertEqual(timestamp(3661),'01:01:01')

    def test_private_and_non_http_video_urls_are_rejected(self):
        for url in ['file:///secret','http://127.0.0.1/private','http://localhost/x','http://169.254.169.254/','https://user:password@example.com/']:
            with self.assertRaises(ValueError): validate_video_url(url)

    def test_public_url_validation_uses_all_resolved_addresses(self):
        with patch('readvideo.transcript.socket.getaddrinfo',return_value=[(2,1,6,'',('8.8.8.8',443)),(2,1,6,'',('127.0.0.1',443))]):
            with self.assertRaises(ValueError): validate_video_url('https://example.com/video')

    def test_segmented_captions_use_ytdlp_subtitle_downloader_not_raw_playlist_text(self):
        from pathlib import Path
        calls=[]
        class Downloader:
            def dl(self, filename, info, subtitle=False):
                calls.append((dict(info),subtitle))
                Path(filename).write_text('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nActual fragment content\n',encoding='utf-8')
                return None,True
        track={'url':'https://example.com/subtitles.m3u8','ext':'vtt','protocol':'m3u8_native'}
        text=download_caption_text(Downloader(),track,{'User-Agent':'test'})
        self.assertIn('Actual fragment content',text)
        self.assertTrue(calls[0][1])
        self.assertEqual(calls[0][0]['protocol'],'m3u8_native')
        self.assertNotIn('http_headers',track)


if __name__=='__main__': unittest.main()
