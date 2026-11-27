"use strict";
const OMBattery = (() => {
  function limits(model) {
    return model === 5 ? {min:2300, write:2900} : {min:2200, write:2800};
  }
  function scaled(mv, width, model) {
    const {min} = limits(model);
    return Math.round(Math.max(0, Math.min(1, (mv-min)/(3200-min))) * width);
  }
  function icon(ctx,x,y,w,h,mv,model) {
    const {write}=limits(model), full=w-4;
    ctx.save();
    ctx.fillStyle="#000";
    ctx.fillRect(x,y,w,1);ctx.fillRect(x,y+h-1,w,1);
    ctx.fillRect(x,y+1,1,h-2);ctx.fillRect(x+w-1,y+1,1,h-2);
    ctx.fillRect(x+w,y+2,2,h-4);
    ctx.fillRect(x+2+scaled(write,full,model),y+h,1,2);
    if (mv>0) {
      ctx.fillStyle=mv<write?"#b81928":"#000";
      ctx.fillRect(x+2,y+2,scaled(mv,full,model),h-4);
    }
    ctx.restore();
  }
  function update(id,mv,model) {
    const wrap=document.getElementById(id), meter=document.getElementById(id+"-rail");
    const known=Number.isInteger(mv) && mv>0 && (model===2 || model===5);
    wrap.hidden=!known;
    if (!known) return;
    const {min,write}=limits(model);
    meter.min=min;meter.max=3200;meter.low=write;meter.optimum=3200;meter.value=mv;
    wrap.classList.toggle("four-color",model===5);
    wrap.classList.toggle("below-reserve",mv<write);
    const translate=typeof OMI18n==="undefined"?s=>s:s=>OMI18n.t(s);
    const status=translate(mv<write?"低于刷机安全线":"已达刷机安全线")+" "+(write/1000).toFixed(2)+" V";
    wrap.title=(mv/1000).toFixed(3)+" V · "+status;
    document.getElementById(id+"-label").textContent=status;
  }
  return {limits,scaled,icon,update};
})();
