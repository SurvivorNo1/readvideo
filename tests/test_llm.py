import unittest
import io
import json
import urllib.error
from unittest.mock import patch
from readvideo.llm import resolve_config, summarize, chat_request


class APIContracts(unittest.TestCase):
    def test_debug_key_is_available_only_to_official_deepseek(self):
        config=resolve_config({'provider':'deepseek','base_url':'https://api.deepseek.com','model':'deepseek-chat'},'memory-only-secret')
        self.assertEqual(config['api_key'],'memory-only-secret')
        for base in ['https://evil.example/v1','https://api.deepseek.com.evil.example','https://api.deepseek.com@evil.example']:
            with self.assertRaises(ValueError): resolve_config({'provider':'deepseek','base_url':base,'model':'m'},'memory-only-secret')

    def test_a_custom_provider_requires_its_own_key(self):
        with self.assertRaises(ValueError): resolve_config({'provider':'custom','base_url':'https://example.com/v1','model':'m'},'memory-only-secret')
        self.assertEqual(resolve_config({'provider':'custom','base_url':'https://example.com/v1','model':'m','api_key':'own-test-key'},'memory-only-secret')['api_key'],'own-test-key')

    def test_insecure_or_ambiguous_api_urls_are_rejected(self):
        for base in ['http://example.com','https://example.com?key=secret','https://user:pw@example.com','https://example.com/#fragment']:
            with self.assertRaises(ValueError): resolve_config({'provider':'custom','base_url':base,'model':'m','api_key':'test'},'')

    def test_generation_uses_all_chunks_and_labels_the_source_as_captions(self):
        transcript={'title':'Video','url':'https://example.com/video','segments':[{'start':i,'text':'x'*6000} for i in range(3)]}
        calls=[]
        def fake(config,messages,**kwargs): calls.append(messages); return '## 摘要\n来自字幕的内容 [00:01]'
        with patch('readvideo.llm.chat_request',side_effect=fake):
            result=summarize(transcript,{'api_key':'test','base_url':'https://example.com','model':'m'},'article','zh')
        self.assertGreaterEqual(len(calls),3)
        self.assertIn('markdown',result)
        self.assertNotIn('api_key',result)
        self.assertIn('字幕',calls[0][0]['content'])

    def test_invalid_mode_or_empty_source_is_rejected(self):
        with self.assertRaises(ValueError): summarize({'segments':[]},{},'article','zh')
        with self.assertRaises(ValueError): summarize({'segments':[{'start':0,'text':'hello'}]},{},'unknown','zh')

    def test_blank_provider_output_is_not_a_success(self):
        with patch('readvideo.llm.chat_request',return_value='   '):
            with self.assertRaises(ValueError): summarize({'title':'Test','url':'','segments':[{'start':0,'text':'hello'}]},{'model':'m'},'brief','zh')

    def test_credentials_with_control_characters_are_rejected_without_echoing_them(self):
        bad='test-secret\nwith-newline'
        with self.assertRaises(ValueError) as error:resolve_config({'provider':'deepseek','api_key':bad,'model':'m'})
        self.assertNotIn('test-secret',str(error.exception))

    def test_deepseek_uses_non_thinking_mode_for_fast_short_responses(self):
        captured={}
        class Opener:
            def open(self,request,timeout):
                captured.update(json.loads(request.data))
                return io.BytesIO(b'{"choices":[{"message":{"content":"OK"},"finish_reason":"stop"}]}')
        with patch('readvideo.llm.urllib.request.build_opener',return_value=Opener()):
            chat_request({'provider':'deepseek','base_url':'https://api.deepseek.com','api_key':'test','model':'deepseek-flash'},[{'role':'user','content':'OK'}],16)
        self.assertEqual(captured.get('thinking'),{'type':'disabled'})

    def test_provider_error_body_and_key_are_not_reflected(self):
        class Opener:
            def open(self,request,timeout):
                raise urllib.error.HTTPError(request.full_url,401,'provider echoed test-secret',{},io.BytesIO(b'test-secret'))
        with patch('readvideo.llm.urllib.request.build_opener',return_value=Opener()):
            with self.assertRaises(ValueError) as error:chat_request({'base_url':'https://example.com','api_key':'test-secret','model':'m'},[])
        self.assertNotIn('test-secret',str(error.exception))


if __name__=='__main__': unittest.main()
