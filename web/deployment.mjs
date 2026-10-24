// Public service location only. Never put API keys or Worker secrets here.
//
// 解析服务部署在 Vercel（AWS us-east-1）。实测出口 3.81.132.67 (AS14618)
// 可以正常访问 B 站；Cloudflare Workers 的出口整站 412，不可用。
//
// 注意：本项必须是「根地址 + 可选子路径」。
// 前端会拼成 <此地址>/resolve。
export const DEFAULT_EDGE_URL = "https://readvideo-resolve.vercel.app/api";
