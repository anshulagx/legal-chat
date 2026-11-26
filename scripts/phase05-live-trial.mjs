// Bounded live provider compatibility trial; only fictional material is sent.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readConfig } from '../server/dist/config.js';
import { openRouterPlan, openRouterGenerate } from '../server/dist/answer-provider.js';
import { validateGroundedOutput } from '../server/dist/answer.js';
const config = readConfig(process.env);
assert.ok(config.answer, 'Configure chat provider for a live trial.');
const versions = [
  { versionId:'111111111111111111111111',generation:'trial',model:'openai/text-embedding-3-small',dimensions:1536,filename:'agreement.txt',scope:'private' },
  { versionId:'222222222222222222222222',generation:'trial',model:'openai/text-embedding-3-small',dimensions:1536,filename:'amendment.txt',scope:'private' },
];
const passages = [
  {id:'agreement-notice',versionId:versions[0].versionId,text:'Clause 7. The customer may terminate the agreement by giving 30 days written notice. Contract exports are available in Settings > Data export > Download ZIP.',filename:'agreement.txt',start:0,end:176},
  {id:'agreement-fee',versionId:versions[0].versionId,text:'Clause 8. The monthly service fee is 20 credits.',filename:'agreement.txt',start:178,end:225},
  {id:'amendment-notice',versionId:versions[1].versionId,text:'Amendment to Clause 7: the notice period is changed from 30 days to 60 days. All other terms remain unchanged.',filename:'amendment.txt',start:0,end:107},
];
for(const passage of passages)passage.end=passage.start+passage.text.length;
const report = {timestamp:new Date().toISOString(), model:config.answer.model, fictionalOnly:true, trials:[]};
for (const [name,message,selected] of [
  ['grounded-stream','How do I export my contracts?',[]],
  ['comparison-stream','Compare the notice period in the agreement and amendment, and the monthly service fee.',versions.map(v=>v.versionId)],
  ['mixed-evidence','What is the notice period, and what is the guaranteed support response SLA?',[]],
]) {
  const started=Date.now(), signal=AbortSignal.timeout(config.answer.deadlineMs);
  const request={message,conversationId:'333333333333333333333333',userMessageId:'444444444444444444444444',attemptId:randomUUID(),ownerId:'555555555555555555555555',config,selectedDocumentVersionIds:selected};
  try {
    const plan=await openRouterPlan(request,versions,signal);
    const chosen=selected.length?selected.map(id=>versions.find(v=>v.versionId===id)):plan.selectedVersionIds.length?plan.selectedVersionIds.map(id=>versions.find(v=>v.versionId===id)):versions;
    let streamed=0,firstParagraphMs;
    const raw=await openRouterGenerate(request,{passages,versions:chosen,history:[],plan},signal,async()=>{streamed++;firstParagraphMs??=Date.now()-started;});
    const result=validateGroundedOutput(raw,passages,chosen,request.attemptId,plan);
    assert.equal(result.followUps.length,2);
    assert.ok(result.citations.length>0);
    if(name==='grounded-stream'){assert.match(result.response,/settings/i);assert.match(result.response,/export/i);assert.match(result.response,/zip/i);}
    if(name==='comparison-stream'){assert.equal(plan.mode,'comparison');assert.ok(result.comparison);const notice=result.comparison.rows.find(row=>/notice/i.test(row.term));assert.ok(notice);assert.match(notice.left.citation.quote,/30 days/);assert.match(notice.right.citation.quote,/60 days/);}
    if(name==='mixed-evidence')assert.ok(result.handoffOffer);
    report.trials.push({name,status:'PASS',mode:plan.mode,paragraphs:result.paragraphs.length,citations:result.citations.length,rows:result.comparison?.rows.length??0,handoff:!!result.handoffOffer,streamedParagraphs:streamed,firstParagraphMs,durationMs:Date.now()-started});
  } catch(error) {
    report.trials.push({name,status:'FAIL',error:error instanceof Error?error.message:'Trial failed',durationMs:Date.now()-started});
  }
}
try {
  const started=Date.now();
  const plan=await openRouterPlan({message:'What changed between my agreements?',conversationId:'333333333333333333333333',userMessageId:'444444444444444444444444',attemptId:randomUUID(),config},
    [...versions,{...versions[0],versionId:'666666666666666666666666',filename:'other-agreement.txt'}],AbortSignal.timeout(config.answer.deadlineMs));
  assert.equal(plan.mode,'clarification');assert.equal(plan.selectedVersionIds.length,0);
  report.trials.push({name:'ambiguous-pair',status:'PASS',mode:plan.mode,durationMs:Date.now()-started});
} catch(error){report.trials.push({name:'ambiguous-pair',status:'FAIL',error:error instanceof Error?error.message:'Trial failed'});}
console.log(JSON.stringify(report,null,2));
await writeFile(new URL('../qa/phase05-live-model-trial.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
if(report.trials.some(t=>t.status!=='PASS'))process.exitCode=1;
