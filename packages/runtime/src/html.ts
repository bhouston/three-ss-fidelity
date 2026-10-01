import type { BenchmarkReport } from './types.js';

/** Self-contained, offline report. Untrusted strings are only inserted with textContent. */
export function reportHtml(report: BenchmarkReport): string {
  const json = JSON.stringify(report)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Screen-space performance report</title>
<style>
:root{color-scheme:dark;font:15px system-ui;background:#10151c;color:#e4eaf2}body{max-width:1180px;margin:40px auto;padding:0 24px}h1{font-size:30px;letter-spacing:-1px}p{color:#aebed0;line-height:1.6}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}td,th{text-align:left;padding:12px;border-bottom:1px solid #293443}th{color:#aebed0;font-size:12px}select{padding:9px;background:#1d2836;color:inherit;border:1px solid #405066;border-radius:6px;margin:8px 8px 8px 0;max-width:100%}section{margin:32px 0}.scroll{overflow:auto}svg{width:100%;height:220px;background:#17202b;border-radius:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#aebed0}.note{font-size:13px}.pill{color:#8dd8c0}h2{font-size:18px}details{margin:20px 0}
</style></head><body>
<span class="pill">SS FIDELITY / PERFORMANCE</span><h1>Rendering performance</h1><p id="identity"></p>
<p>Mean, standard deviation and p95 below describe samples within each repetition. Repeat variation is reported separately. Throughput samples are batches; their p95 does not describe individual frame latency. Profile runs change synchronization and must be compared separately.</p>
<section><h2>Runs</h2><div class="scroll"><table><thead><tr><th>Scene / renderer</th><th>Protocol</th><th>Repeat</th><th>FPS</th><th>Mean ms</th><th>Stddev ms</th><th>Median ms</th><th>p95 ms</th><th>Samples</th></tr></thead><tbody id="runs"></tbody></table></div></section>
<section><h2>Variation between repetitions</h2><div id="variation"></div></section>
<section id="comparison-section" hidden><h2>Paired comparisons</h2><div id="comparisons"></div></section>
<section><h2>Timing samples</h2><select id="entry" aria-label="Scene and renderer"></select><select id="repeat" aria-label="Repetition"></select><select id="metric" aria-label="Metric"></select><p id="description" class="note"></p><svg id="chart" viewBox="0 0 1000 220" role="img" aria-label="Timing samples in acquisition order"></svg><p id="range" class="note"></p></section>
<details><summary>Environment and source provenance</summary><pre id="metadata"></pre></details>
<script id="report" type="application/json">${json}</script>
<script>
const report=JSON.parse(document.getElementById('report').textContent);
const get=id=>document.getElementById(id);
const format=n=>Number(n).toFixed(3);
const primary=p=>p==='throughput'?'throughput.frame':p==='cadence'?'cadence.frame':'profile.frame';
get('identity').textContent=report.id+' · '+report.generatedAt;
get('metadata').textContent=JSON.stringify({environment:report.environment,provenance:report.provenance},null,2);
for(const comparison of report.comparisons||[]){get('comparison-section').hidden=false;const p=document.createElement('p');p.textContent=comparison.scene+' / '+comparison.baseline+' → '+comparison.candidate+': '+format(comparison.speedup.mean)+'× mean speedup; '+format(comparison.speedup.stddev)+' repetition stddev ('+comparison.speedup.n+' paired repetitions). Greater than 1 means the candidate is faster in this run.';get('comparisons').append(p)}
function option(select,value,label){const o=document.createElement('option');o.value=String(value);o.textContent=label;select.append(o)}
report.entries.forEach((entry,index)=>{
 option(get('entry'),index,entry.scene+' / '+entry.renderer+' / '+entry.experiment);
 const means=[];
 entry.runs.forEach((run,i)=>{
  const metric=run.metrics.find(m=>m.descriptor.id===primary(run.options.protocol));
  if(!metric)return;
  means.push(metric.statistics.mean);
  const tr=document.createElement('tr');
  [entry.scene+' / '+entry.renderer,run.options.protocol,i+1,run.fps.toFixed(1),format(metric.statistics.mean),format(metric.statistics.stddev),format(metric.statistics.median),format(metric.statistics.p95),metric.statistics.n+' '+metric.sampleUnit+'s'].forEach(value=>{const td=document.createElement('td');td.textContent=String(value);tr.append(td)});
  get('runs').append(tr);
 });
 if(means.length){const mean=means.reduce((a,b)=>a+b,0)/means.length;const sd=means.length>1?Math.sqrt(means.reduce((a,b)=>a+(b-mean)**2,0)/(means.length-1)):0;const p=document.createElement('p');p.textContent=entry.scene+' / '+entry.renderer+': '+format(mean)+' ms mean of repetition means; '+(means.length>1?format(sd)+' ms repetition stddev':'one repetition; variability not established');get('variation').append(p)}
});
function run(){return report.entries[Number(get('entry').value)]?.runs[Number(get('repeat').value)]}
function draw(){const metric=run()?.metrics[Number(get('metric').value)];get('chart').replaceChildren();if(!metric)return;const samples=metric.samples;const max=samples.reduce((value,s)=>Math.max(value,s.value),0.001);const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',samples.map((s,i)=>(i?'L':'M')+(20+i*960/Math.max(1,samples.length-1))+','+(200-s.value/max*180)).join(' '));path.setAttribute('fill','none');path.setAttribute('stroke','#83c6ff');path.setAttribute('stroke-width','1.5');get('chart').append(path);const r=run();get('description').textContent=metric.descriptor.description+' Sample unit: '+metric.sampleUnit+'.'+(r.profiling.status!=='disabled'?' GPU profiling: '+r.profiling.status+(r.profiling.reason?' — '+r.profiling.reason:'')+'; invalid samples: '+r.profiling.invalidSamples+'.':'');get('range').textContent=samples.length+' samples · range 0–'+format(max)+' '+metric.descriptor.unit+' · frame '+samples[0]?.frame+'–'+samples.at(-1)?.frame+' · mean '+format(metric.statistics.mean)+' · p95 '+format(metric.statistics.p95);}
function metrics(){get('metric').replaceChildren();run()?.metrics.forEach((m,i)=>option(get('metric'),i,m.descriptor.label));const r=run();if(r&&r.profiling.status!=='disabled'){const p=document.createElement('p');p.textContent='GPU profiling: '+r.profiling.status+(r.profiling.reason?' — '+r.profiling.reason:'')+'; invalid samples: '+r.profiling.invalidSamples;get('description').textContent=p.textContent}draw()}
function repeats(){get('repeat').replaceChildren();report.entries[Number(get('entry').value)]?.runs.forEach((r,i)=>option(get('repeat'),i,'Repetition '+(i+1)+' / '+r.options.protocol));metrics()}
get('entry').addEventListener('change',repeats);get('repeat').addEventListener('change',metrics);get('metric').addEventListener('change',draw);repeats();
</script></body></html>`;
}
