import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../server/dist/config.js';
import { exportAnswerTrace } from '../server/dist/answer-telemetry.js';
const config=readConfig(process.env);
if(!config.telemetry)throw new Error('Langfuse is not configured.');
const traceId=randomUUID().replaceAll('-','');
const report={timestamp:new Date().toISOString(),traceId,contentFree:true,ingestion:'BLOCKED',readback:'BLOCKED'};
try {
  const receipt=await exportAnswerTrace(config,{traceId,attemptId:randomUUID(),userMessageId:randomUUID(),conversationId:randomUUID(),started:Date.now()-30,terminal:'completed',timings:{retrievalMs:10,generationMs:15,validationMs:5,firstParagraphMs:20},snapshot:{versions:[],keywordCandidateIds:[],vectorCandidateIds:[],selectedChunkIds:[]}});
  if(receipt?.accepted)report.ingestion='PASS';
  for(let trial=0;trial<5;trial++){
    const response=await fetch(`${config.telemetry.baseUrl}/api/public/v2/observations?${new URLSearchParams({traceId,fields:'core,basic',limit:'100',fromStartTime:new Date(Date.now()-60000).toISOString(),toStartTime:new Date(Date.now()+60000).toISOString()})}`,{headers:{Authorization:`Basic ${Buffer.from(`${config.telemetry.publicKey}:${config.telemetry.secretKey}`).toString('base64')}`},signal:AbortSignal.timeout(10000)});
    if(response.ok){const data=await response.json();const observations=data.data??[];if(observations.some(o=>o.traceId===traceId)){report.readback='PASS';report.observationCount=observations.length;break;}}
    if(!response.ok&&response.status!==404){report.readback=`FAIL_HTTP_${response.status}`;break;}
    await delay(2000);
  }
} catch(error){report.error=error instanceof Error?error.message:'Telemetry probe failed';}
await writeFile(new URL('../qa/phase05-live-telemetry.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
if(report.ingestion!=='PASS'||report.readback!=='PASS')process.exitCode=1;
