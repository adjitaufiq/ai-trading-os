import { it } from "vitest";
import { ema } from "@/core/technical/indicators";
import { operatorAnalysis } from "@/core/technical/operator";
const TF:any={M5:3e5,M15:9e5,H1:36e5,H4:144e5};
const series=(tf:string,c:number[])=>c.map((x,i)=>{const o=1.7e12+i*TF[tf];return {open_time:o,close_time:o+TF[tf],available_at:o+TF[tf],open:x,high:x+.5,low:x-.5,close:x}});
const Z=[0,1,2,3,4,3,2,1];const up=(k:number)=>Array.from({length:k},(_,i)=>100+i*.3+Z[i%8]!);
const down=(k:number)=>Array.from({length:k},(_,i)=>200-i*.3-Z[i%8]!);
it("d",()=>{
 const R=(k:number)=>Array.from({length:k},(_,i)=>100+2*Z[i%8]!);
 for (const h1c of [R(60), [...R(57),104,106,108], [...R(56),101,103,105,107], [...R(52),...up(8).map(x=>x)], R(61).slice(1), R(63).slice(3)]) {
  const H1=series("H1",h1c);const M15=series("M15",up(60));const p=(ema(M15,21) as any).value;
  const m5=series("M5",up(40));m5[38]={...m5[38]!,open:120,high:120.2,low:118.8,close:119};m5[39]={...m5[39]!,open:118.9,high:121.2,low:118.7,close:121};
  const o=operatorAnalysis({M5:m5,M15,H1,H4:series("H4",up(60))} as any,p);
  console.log("R",o.h4_primary,o.h1_context,JSON.stringify(o.checks),o.candidate,o.reason,o.alignment,o.ema_confluence.timeframe);}
 {const H1=series("H1",R(60));const M15=series("M15",up(60));const H4=series("H4",down(60));
  const m5=series("M5",up(40));m5[38]={...m5[38]!,open:120,high:120.2,low:118.8,close:119};m5[39]={...m5[39]!,open:118.9,high:121.2,low:118.7,close:121};
  const pr=operatorAnalysis({M5:m5,M15,H1,H4} as any,(ema(M15,21) as any).value);
  console.log("C0",pr.location,pr.nearest_support?.low,pr.nearest_support?.high,pr.status,pr.reason);
  for (const p of [pr.nearest_support?.high, pr.nearest_support?.low, 100, 101, 102]) { if(p==null)continue;
   const o=operatorAnalysis({M5:m5,M15,H1,H4} as any,p);console.log("C",p,o.h4_primary,o.location,JSON.stringify(o.checks),o.status,o.candidate,o.reason,o.alignment);}}
});
