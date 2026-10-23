import json
import threading
import time
import unittest
import urllib.request
import urllib.error
from unittest.mock import patch
from readvideo.server import create_server


class HTTPContracts(unittest.TestCase):
    def setUp(self):
        self.server=create_server('127.0.0.1',0,debug_key='memory-only-secret')
        threading.Thread(target=self.server.serve_forever,daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base='http://127.0.0.1:'+str(self.server.server_address[1])
        self.bootstrap=json.load(urllib.request.urlopen(self.base+'/api/bootstrap'))

    def request(self,path,data,token=True,origin=None):
        headers={'Content-Type':'application/json'}
        if token: headers['X-Readvideo-Token']=self.bootstrap['token']
        if origin: headers['Origin']=origin
        req=urllib.request.Request(self.base+path,data=json.dumps(data).encode(),headers=headers)
        return urllib.request.urlopen(req)

    def test_bootstrap_only_discloses_key_availability(self):
        self.assertTrue(self.bootstrap['server_key_available'])
        self.assertNotIn('memory-only-secret',json.dumps(self.bootstrap))

    def test_missing_token_and_foreign_origin_are_rejected(self):
        for token,origin in [(False,None),(True,'https://evil.example')]:
            with self.assertRaises(urllib.error.HTTPError) as error:self.request('/api/extract',{'url':'https://example.com/video'},token,origin)
            self.assertEqual(error.exception.code,403)

    def test_static_page_is_served_and_hidden_paths_are_not(self):
        response=urllib.request.urlopen(self.base+'/')
        self.assertIn('readvideo',response.read().decode())
        with self.assertRaises(urllib.error.HTTPError):urllib.request.urlopen(self.base+'/.env')

    def test_extraction_job_returns_real_segments_from_the_extractor(self):
        result={'title':'Example','url':'https://example.com/video','segments':[{'start':0,'text':'Actual captions'}],'language':'en','automatic':False,'duration':2}
        with patch('readvideo.server.extract_transcript',return_value=result):
            job=json.load(self.request('/api/extract',{'url':'https://example.com/video','language':'auto'}))
            for _ in range(30):
                req=urllib.request.Request(self.base+'/api/jobs/'+job['id'],headers={'X-Readvideo-Token':self.bootstrap['token']})
                state=json.load(urllib.request.urlopen(req))
                if state['status']=='done':break
                time.sleep(.01)
        self.assertEqual(state['result']['segments'][0]['text'],'Actual captions')
        self.assertNotIn('memory-only-secret',json.dumps(state))

    def test_generation_requires_server_owned_transcript(self):
        with self.assertRaises(urllib.error.HTTPError) as error:self.request('/api/generate',{'transcript_id':'missing','mode':'brief','config':{'provider':'deepseek','model':'m'}})
        self.assertEqual(error.exception.code,400)

    def test_article_length_is_forwarded_and_invalid_lengths_are_rejected(self):
        source=json.load(self.request('/api/import',{'title':'Test','content':'1\n00:00:00,000 --> 00:00:01,000\nEntire source.\n','format':'srt'}))
        data={'transcript_id':source['transcript_id'],'mode':'article','length':'detailed','config':{'provider':'deepseek'}}
        with patch('readvideo.server.summarize',return_value={'markdown':'Article'}) as generate:
            job=json.load(self.request('/api/generate',data))
            for _ in range(30):
                if generate.called:break
                time.sleep(.01)
            self.assertEqual(generate.call_args.kwargs.get('length'),'detailed')
        data['length']='huge'
        with self.assertRaises(urllib.error.HTTPError) as error:self.request('/api/generate',data)
        self.assertEqual(error.exception.code,400)


if __name__=='__main__': unittest.main()
