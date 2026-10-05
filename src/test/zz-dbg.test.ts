import { it } from "vitest";
import { ema } from "@/core/technical/indicators";
import { operatorAnalysis } from "@/core/technical/operator";
const TF:any={M5:3e5,M15:9e5,H1:36e5,H4:144e5};
const series=(tf:string,c:number[])=>c.map((x,i)=>{const o=1.7e12+i*TF[tf];return {open_time:o,close_time:o+TF[tf],available_at:o+TF[tf],open:x,high:x+.5,low:x-.5,close:x}});
const Z=[0,1,2,3,4,3,2,1];const up=(k:number)=>Array.from({length:k},(_,i)=>100+i*.3+Z[i%8]!);
const down=(k:number)=>Array.from({length:k},(_,i)=>200-i*.3-Z[i%8]!);
it("d",()=>{
 for (const tail of [[113,112,111.5,111.2],[112,110,108,107],[114,113,112,111,110,109],[115,113,111,110]]) {
  const H1=series("H1",[...up(60-tail.length),...tail]);const p=(ema(H1,21) as any).value;
  const m5=series("M5",up(40));m5[38]={...m5[38]!,open:120,high:120.2,low:118.8,close:119};m5[39]={...m5[39]!,open:118.9,high:121.2,low:118.7,close:121};
  const o=operatorAnalysis({M5:m5,M15:series("M15",up(60)),H1,H4:series("H4",up(60))} as any,p);
  console.log(JSON.stringify(tail),o.h4_primary,o.h1_context,o.checks,o.candidate,o.reason,o.alignment);}
 const cl:any={M5:series("M5",down(40)),M15:series("M15",down(60)),H1:series("H1",down(60)),H4:series("H4",down(60))};
 const pr=operatorAnalysis(cl,0);console.log("sup",pr.nearest_support?.high, pr.location);
});
