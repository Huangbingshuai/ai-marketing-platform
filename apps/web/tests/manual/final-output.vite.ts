import { fileURLToPath } from 'node:url';
import { createReadStream, statSync } from 'node:fs';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// Opt-in isolated browser fixture. No proxy, database access, queue or supplier calls.
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api') },
  resolve: { alias: { '@ai-marketing/contracts': fileURLToPath(new URL('../../../../packages/contracts/src/index.ts', import.meta.url)) } },
  optimizeDeps: { exclude: ['@ai-marketing/contracts'] },
  plugins: [vue(), {name:'isolated-output-fixture', configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = req.url ?? '';
      if (!url.startsWith('/api/')) return next();
      const mode = url.match(/projects\/fixture-([^/]+)/)?.[1];
      if (!mode) { res.statusCode=404; return res.end(); }
      if (url.includes('/file-objects/')) {
        const path = process.env.OUTPUT_FIXTURE_VIDEO;
        if (!path) {res.statusCode=404; return res.end();}
        const size = statSync(path).size;
        const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
        const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]),size-1) : size-1;
        res.statusCode=range?206:200; res.setHeader('Content-Type','video/mp4'); res.setHeader('Accept-Ranges','bytes');res.setHeader('Content-Length',end-start+1);
        if(range)res.setHeader('Content-Range',`bytes ${start}-${end}/${size}`);
        if(url.includes('download=true'))res.setHeader('Content-Disposition','attachment; filename="fixture.mp4"');
        return createReadStream(path,{start,end}).pipe(res);
      }
      res.setHeader('Content-Type','application/json');
      if (mode==='error') {res.statusCode=503; return res.end(JSON.stringify({message:'隔离测试：服务暂时不可用'}));}
      if(req.method==='POST') return res.end(JSON.stringify({data:{accepted:true}}));
      if(mode==='empty') return res.end(JSON.stringify({data:[]}));
      const output = url.includes('/final-output');
      const items=Array.from({length:100},(_,i)=>{
        const status=mode==='running' ? i<20?'COMPLETED':i<24?'RUNNING':'QUEUED' : mode==='failed' && i===99?'FAILED':'COMPLETED';
        const common={id:`i${i}`,variantId:`v${i}`,name:`成片 ${i+1}`,status,errorMessage:status==='FAILED'?'测试失败：可恢复，不重做成功项':null};
        if(output)return {...common,duration:4,progress:status==='COMPLETED'?100:status==='RUNNING'?50:0,fileObjectId:status==='COMPLETED'?'video':null,assetId:null};
        return {...common,shardIndex:Math.floor(i/4),sourceTimelineHash:'fixture',sourceVisualTimeline:{id:`v${i}`,slots:[],bindings:{},bindingRevisions:{},offsets:{},timelineStarts:{},videoLanes:{}},stage:status==='COMPLETED'?'READY':status==='RUNNING'?'VOICE':'SNAPSHOT',checkpoint:{},stale:mode==='stale'&&i===99,startedAt:null,completedAt:null};
      });
      const completed=items.filter(i=>i.status==='COMPLETED').length;
      const run={id:'fixture-output',templateId:'fixture-template',workflowRunId:'fixture-run',createdAt:new Date(0).toISOString(),startedAt:new Date(0).toISOString(),completedAt:null,status:mode==='running'?'RUNNING':mode==='failed'?'PARTIAL':'COMPLETED',items,
        counts:{total:100,completed,queued:mode==='running'?76:0,running:mode==='running'?4:0,failed:mode==='failed'?1:0,stale:mode==='stale'?1:0,shards:25},
        execution:{progressPercent:22,queued:76,running:4,completed:20,elapsedSeconds:400,throughputPerMinute:3,estimatedRemainingSeconds:1600,estimateBasis:'OBSERVED',delayed:false,shards:[]}};
      return res.end(JSON.stringify({data:[run]}));
    });
  }}],
  server:{host:'127.0.0.1',port:5174,strictPort:true,fs:{allow:[fileURLToPath(new URL('../../../..',import.meta.url))]}},
});
