"use strict";

const SecureUpdate = (() => {
  const characteristicId = "93adab05-76ce-468d-8bd8-f2420ecc4172";
  const publisher = "BBY3sGp55LxXQ9qphoac7AJvMS+1stVEm507LZ5TzsKP8yu+EFYiJ36yxj7pogHVgMYBWtuvNVMdnz9iKujRzLk=";
  const families = {2:"30c0ef3ebbcd0b1395a0c7ddd56a1295ef5793e3f3b4ca867da7fd45888c5648",5:"d0982ce1439191f7020909d275ca0603c32117e46bce335ecb72caf0ca27607b"};
  const errors = ["", "电压不足，请稳定供电后重新升级。", "设备拒绝了此升级包的签名、屏型或版本。", "升级页校验或写入失败。", "运行镜像校验失败。", "升级记录写入失败。"];
  const hex = bytes => Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
  const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));

  async function parse(buffer) {
    const bytes=new Uint8Array(buffer), view=new DataView(buffer);
    if(bytes.length<148 || new TextDecoder().decode(bytes.subarray(0,8))!=="E42OTA04")
      throw Error("请选择加密版 V4 的 .e42ota 文件。");
    const model=view.getUint32(8,true), version=view.getUint32(12,true), count=view.getUint32(16,true);
    if(!families[model] || version<3401 || count<1 || count>60 || bytes.length!==148+4112*count ||
        hex(bytes.subarray(52,84))!==families[model]) throw Error("升级包长度、屏型或授权系列有误。");
    const key=await crypto.subtle.importKey("raw",Uint8Array.from(atob(publisher),c=>c.charCodeAt(0)),{name:"ECDSA",namedCurve:"P-256"},false,["verify"]);
    if(!await crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},key,bytes.subarray(84,148),bytes.subarray(0,84)))
      throw Error("升级包签名校验失败。");
    return {bytes,model,version,digest:hex(bytes.subarray(20,28))};
  }
  async function status(ch) {
    const v=await ch.readValue();
    if(v.byteLength!==20 || v.getUint8(0)!==4) throw Error("本屏未提供 V4 无线升级接口。");
    const error=v.getUint8(3);
    if(error)throw Error(errors[error] || "设备停止了此次升级。");
    return {mode:v.getUint8(1),model:v.getUint8(2),offset:v.getUint32(4,true),version:v.getUint32(8,true),digest:hex(new Uint8Array(v.buffer,v.byteOffset+12,8))};
  }
  async function channel(device) {
    const server=await device.gatt.connect(), svc=await server.getPrimaryService(ELActivation.SERVICE);
    return svc.getCharacteristic(characteristicId);
  }
  async function afterReboot(device,mode,model) {
    const end=Date.now()+60000;
    // Wait for the device's own reset. Disconnecting too early can reconnect
    // to the still-running sender and leave its old services cached.
    while(device.gatt.connected && Date.now()<end)await sleep(150);
    while(Date.now()<end) {
      await sleep(700);
      try {
        const ch=await channel(device), state=await status(ch);
        if(state.mode===mode && state.model===model)return {ch,state};
      } catch {}
      device.gatt.disconnect();
    }
    throw Error("等待同一块屏幕重启超时。请重新连接后核对版本。");
  }
  async function transfer(client,pkg,progress) {
    if(!pkg || pkg.model!==client.config?.model || !(client.sdkCapabilities&0x8000))throw Error("升级包与已连接的加密屏不匹配。");
    const device=client.device, service=await device.gatt.getPrimaryService(ELActivation.SERVICE);
    const power=await ELActivation.readPower(service);
    if(!power?.mv || power.mv<power.minimum)throw Error("电压不足，当前 "+((power?.mv||0)/1000).toFixed(2)+" V。");
    const app=await service.getCharacteristic(characteristicId), before=await status(app);
    if(before.mode!==0 || before.model!==pkg.model || before.version>pkg.version)throw Error("本屏无法安装所选版本。");
    let payload=Math.min(client.reportedPayload || 180,244)-5;
    let ch,committed=false;
    try {
      progress(0,"正在进入无线升级模式…");
      await app.writeValueWithResponse(new TextEncoder().encode("E42RX004"));
      ({ch}=await afterReboot(device,1,pkg.model));
      let offset=0, shown=-1;
      while(offset<pkg.bytes.length) {
        const count=Math.min(payload,pkg.bytes.length-offset), packet=new Uint8Array(5+count);
        packet[0]=0xa1;new DataView(packet.buffer).setUint32(1,offset,true);packet.set(pkg.bytes.subarray(offset,offset+count),5);
        try { await ch.writeValueWithResponse(packet); }
        catch(error) {
          if(!device.gatt.connected)throw error;
          const ack=await status(ch);
          if(ack.offset===offset && payload>15){payload=15;continue;}
          if(ack.offset!==offset+count)throw error;
        }
        offset+=count;
        const percent=Math.floor(offset*97/pkg.bytes.length);
        if(percent!==shown){shown=percent;progress(percent,"正在传输加密固件 "+percent+"%");}
      }
      if((await status(ch)).offset!==pkg.bytes.length)throw Error("屏幕接收长度有误。");
      progress(98,"正在校验并重启…");
      await ch.writeValueWithResponse(Uint8Array.of(0xa2));committed=true;
      const {state}=await afterReboot(device,0,pkg.model);
      if(state.version!==pkg.version || state.digest!==pkg.digest)throw Error("屏幕已恢复运行，但读回的镜像与升级包不符。");
      progress(100,"升级完成，已核对版本和镜像。");
    } catch(error) {
      if(ch && !committed && device.gatt.connected) {
        try {await status(ch);} catch(reason){error=reason;}
        try {await ch.writeValueWithResponse(Uint8Array.of(0xaf));} catch {}
      }
      throw error;
    } finally {device.gatt.disconnect();}
  }
  return {parse,transfer};
})();
