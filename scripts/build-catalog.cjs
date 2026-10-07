/* Rebuild the offline UI catalog from the complete supplied research review. */
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=f=>JSON.parse(fs.readFileSync(path.join(root,'research',f),'utf8'));
const sources=read('source_catalog.json'),mechanisms=read('mechanisms.json'),checklist=read('design_checklist.json');
if(sources.sources.length!==20||mechanisms.mechanisms.length!==14||checklist.gates.length!==16)throw new Error('Unexpected research pack counts.');
const catalog={schemaVersion:1,kind:'finance-research-catalog',updatedAt:sources.verified_at_utc,sources:sources.sources.map(s=>({
 id:s.id,title:s.title,url:s.url,version:s.version,status:s.status==='identity_verified_only'?'partially-verified':'verified',
 summary:'Primary-source review supplied with this project. '+s.status.replaceAll('_',' ')+'. No task-specific run or independent replication is established.',
 claims:[...(s.facts||[]),...(s.verified_claims||[]).map(c=>c.claim+' [Location: '+c.location+'; '+c.status+']'),...(s.locations?.length?['Source anchors: '+s.locations.join('; ')]:[]),...(s.pinned_url?['Pinned source: '+s.pinned_url]:[])],
 limits:[...(s.cautions||[]),...(s.limits||[]),...(s.access_license?['Access: '+s.access_license.access,'Declared license: '+s.access_license.declared_license+' ('+s.access_license.location+')']:[])].join(' ')
})),mechanisms:mechanisms.mechanisms.map(m=>({id:m.id,title:m.label,description:m.root_cause,designQuestion:m.interpretive_step,status:'Source-motivated design hypothesis; not tested on this task. No hardness claim allowed.',sourceIds:[...new Set(m.evidence.map(e=>e.source_id))],requirements:m.required_source_facts,fairness:m.fairness_checks,leakage:m.leakage_checks,wrongReading:m.plausible_wrong_reading,decisionImpact:m.decision_impact,evidence:m.evidence.map(e=>e.source_id+': '+e.location)}))};
fs.writeFileSync(path.join(root,'catalog.js'),'/* Generated from research/*.json. See scripts/build-catalog.cjs. */\nwindow.FinanceCatalog = '+JSON.stringify(catalog,null,2)+';\n');
fs.writeFileSync(path.join(root,'research-catalog.json'),JSON.stringify(catalog,null,2)+'\n');
fs.writeFileSync(path.join(root,'research-gates.js'),'/* Source-reviewed acceptance checklist; author assessments only. */\nwindow.FinanceResearchGates = '+JSON.stringify(checklist,null,2)+';\n');
console.log('Built 20 research sources, 14 mechanisms, and 16 review gates.');
