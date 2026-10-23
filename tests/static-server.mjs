// Test/authoring server only. Production is static GitHub Pages.
import {fileURLToPath} from 'node:url';import http from 'node:http';import fs from 'node:fs/promises';import path from 'node:path';
export async function serve(root,port=0){
 const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.wav':'audio/wav'};
 const server=http.createServer(async(req,res)=>{try{const relative=decodeURIComponent(new URL(req.url,'http://localhost').pathname),file=path.resolve(root,'.'+relative+(relative.endsWith('/')?'index.html':''));if(!file.startsWith(path.resolve(root)+path.sep))throw Error();const data=await fs.readFile(file);res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data);}catch{res.writeHead(404);res.end('Not found');}});
 await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));return{server,url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(resolve=>server.close(resolve))};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const s=await serve(path.resolve(process.argv[2]||'web'),Number(process.argv[3]||4186));console.log(s.url);}
