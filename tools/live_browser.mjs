// Explicitly opt-in: uses the live local server and its authorized memory key.
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.READVIDEO_PLAYWRIGHT_PATH||'playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
await fs.mkdir(path.join(root,'docs/images'),{recursive:true});
const browser=await chromium.launch({channel:process.env.READVIDEO_BROWSER_CHANNEL||'chrome',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:4174');await page.getByLabel('视频链接',{exact:true}).waitFor();
  await page.screenshot({path:path.join(root,'docs/images/home.png'),fullPage:true});
  await page.getByLabel('视频链接',{exact:true}).fill(process.env.READVIDEO_LIVE_URL||'https://www.ted.com/talks/derek_sivers_how_to_start_a_movement');
  await page.getByText('完整文章',{exact:true}).click();
  await page.getByLabel('文章篇幅',{exact:true}).selectOption(process.env.READVIDEO_LIVE_LENGTH||'medium');
  await page.getByRole('button',{name:'提取并生成',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('#generate').disabled,{},{timeout:240000});
  const failure=await page.locator('#error').evaluate(el=>el.hidden?'':el.textContent);
  if(failure)throw new Error(failure);
  const article=await page.locator('#article').textContent();assert.ok(article.length>200,'Real model output should contain a substantive article.');
  assert.deepEqual(errors,[]);assert.match(await page.locator('#source-title').textContent(),/movement/i);
  await page.locator('#reading').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,'docs/images/article.png')});
  await fs.writeFile(path.join(root,'.qa/live-article.md'),article);
  const result={kind:'real yt-dlp extraction and real DeepSeek request',testedAt:new Date().toISOString(),title:await page.locator('#source-title').textContent(),cues:Number(await page.locator('#cue-count').textContent()),articleCharacters:article.length,model:await page.locator('#result-meta').textContent(),keyWrittenToDisk:false};
  await fs.writeFile(path.join(root,'.qa/live-result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}finally{await browser.close();}
