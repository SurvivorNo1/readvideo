// Authorized opt-in browser-direct API smoke. Read credential from a pipe only.
import {chromium} from 'playwright';import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import {serve} from './static-server.mjs';
let key='';for await(const data of process.stdin)key+=data;key=key.trim();if(!key)throw Error('Missing memory-only credential');
const site=await serve(path.resolve('web')),browser=await chromium.launch({channel:process.env.READVIDEO_BROWSER_CHANNEL||'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});await page.goto(site.url);
 await page.getByRole('button',{name:'API 配置',exact:true}).click();await page.getByLabel('API Key',{exact:true}).fill(key);key='';await page.getByRole('button',{name:'保存配置',exact:true}).click();
 const source=JSON.parse(await fs.readFile('.qa/live-transcript.json','utf8'));
 const file=path.resolve('.qa/live-web-source.json');await fs.writeFile(file,JSON.stringify({body:source.segments.map(s=>({from:s.start,content:s.text}))}));
 await page.locator('#subtitle-file').setInputFiles(file);await page.waitForFunction(()=>document.querySelectorAll('.cue').length>1);
 await page.getByRole('tab',{name:'阅读笔记',exact:true}).click();await page.getByLabel('文章篇幅',{exact:true}).selectOption('medium');await page.getByRole('button',{name:'根据字幕生成 →',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('#generate').disabled,null,{timeout:200000});const error=await page.locator('#error').evaluate(e=>e.hidden?'':e.textContent);if(error)throw Error(error);
 const text=await page.locator('#article').textContent();assert.ok(text.length>300);const stored=await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}));assert.ok(!/sk-[A-Za-z0-9_-]{24,}/.test(stored));
 await page.locator('#reading').scrollIntoViewIfNeeded();await page.screenshot({path:'docs/images/article.png'});
 console.log(JSON.stringify({kind:'real browser-direct DeepSeek request, no backend or proxy',characters:text.length,sourceCues:source.segments.length,testedAt:new Date().toISOString()},null,2));
}finally{await browser.close();await site.close();}
