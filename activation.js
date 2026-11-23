"use strict";

// The browser transports public requests and signed envelopes. Secrets stay off the site.
const ELActivation = (() => {
  const SERVICE = "93adab00-76ce-468d-8bd8-f2420ecc4172";
  const STATUS  = "93adab01-76ce-468d-8bd8-f2420ecc4172";
  const REQUEST = "93adab02-76ce-468d-8bd8-f2420ecc4172";
  const LICENSE = "93adab03-76ce-468d-8bd8-f2420ecc4172";
  const POWER = "93adab04-76ce-468d-8bd8-f2420ecc4172";
  const STATES = ["pending", "active", "verifying", "rejected", "lowVoltage", "noVoltage", "controlError"];

  function bytes(view) {
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
  }
  function hex(data) {
    return Array.from(data, value => value.toString(16).padStart(2, "0")).join("");
  }
  function prefix(data, magic) {
    return data[4] === 1 && [...magic].every((c, i) => data[i] === c.charCodeAt(0));
  }
  async function parseRequest(data) {
    if (data.length !== 109 || !prefix(data, "E4RQ") || ![2, 5].includes(data[5]) || data[12] !== 4)
      throw new Error("屏幕返回的激活请求格式有误。请核对固件版本。");
    const mac = data.slice(6, 12);
    if (mac.every(b => b === 0) || mac.every(b => b === 255))
      throw new Error("屏幕返回的 MAC 无效。");
    await crypto.subtle.importKey("raw", data.slice(12, 77), {name: "ECDH", namedCurve: "P-256"}, false, []);
    return {
      data: data.slice(), model: data[5],
      mac: Array.from(mac, b => hex([b]).toUpperCase()).join(":"),
      hash: new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
    };
  }
  async function getService(server) {
    try { return await server.getPrimaryService(SERVICE); }
    catch (error) {
      if (error.name === "NotFoundError" || error.name === "SecurityError")
        throw new Error("屏幕未提供激活服务。请确认已刷入对应屏型的测试 HEX。");
      throw error;
    }
  }
  async function readReport(service) {
    const c = await service.getCharacteristic(STATUS);
    const value = bytes(await c.readValue());
    const powerFailure = value[1] === 4 || value[1] === 5;
    if (value.length !== (powerFailure ? 6 : 2) || value[0] !== 1 || value[1] >= STATES.length)
      throw new Error("无法识别设备授权状态。请核对固件版本。");
    return {state: STATES[value[1]], failedMv: powerFailure ? value[2] | value[3] << 8 : null,
      minimum: powerFailure ? value[4] | value[5] << 8 : null};
  }
  async function readStatus(service) { return (await readReport(service)).state; }
  async function readPower(service) {
    let characteristic;
    try { characteristic = await service.getCharacteristic(POWER); }
    catch (err) { if (err.name === "NotFoundError") return null; throw err; }
    const value = await characteristic.readValue();
    if (value.byteLength !== 4 && value.byteLength !== 5) throw Error("屏幕返回的电压读数格式有误。");
    return {mv:value.getUint16(0,true), minimum:value.getUint16(2,true),
      controlBoot:value.byteLength===5 && value.getUint8(4)===1};
  }
  async function requireActive(server) {
    const service = await getService(server);
    const state = await readStatus(service);
    if (state !== "active") throw new Error("屏幕尚未确认激活。请先返回激活页面。");
    if ((await readPower(service))?.controlBoot)
      throw Error("授权已保存。请给屏幕重新上电，待控制程序启动后再连接。");
  }
  async function readRequest(service) {
    const c = await service.getCharacteristic(REQUEST);
    return parseRequest(bytes(await c.readValue()));
  }
  async function sendLicense(service, license, signal) {
    if (license.length !== 226 || !prefix(license, "E4LC"))
      throw new Error("请选择发布者返回的 .e42lic 授权文件。");
    const request = await readRequest(service);
    if (!request.hash.every((b, i) => license[5 + i] === b))
      throw new Error("授权文件与当前屏幕的激活请求不匹配。请重新导出本屏的请求。");
    const current = await readStatus(service);
    if (current === "active") return current;
    if (current === "verifying") throw new Error("屏幕正在验签，请稍后读取状态。");
    const power = await readPower(service);
    if (power && !power.mv) throw Error("屏幕还没有有效电压读数。请保持供电并重读状态。");
    if (power && power.mv < power.minimum) throw Error(`板载电压不足（${(power.mv/1000).toFixed(3)} V，激活最低 ${(power.minimum/1000).toFixed(3)} V）。请稳定供电后重试。`);
    const c = await service.getCharacteristic(LICENSE);
    // A default ATT MTU leaves 20 bytes per write, including our 3-byte chunk header.
    signal.throwIfAborted();
    await c.writeValueWithResponse(Uint8Array.of(1, license.length & 255, license.length >> 8));
    for (let offset = 0; offset < license.length; offset += 17) {
      signal.throwIfAborted();
      const chunk = license.slice(offset, offset + 17);
      await c.writeValueWithResponse(Uint8Array.of(2, offset & 255, offset >> 8, ...chunk));
    }
    signal.throwIfAborted();
    await c.writeValueWithResponse(Uint8Array.of(3));
    let result = await readStatus(service);
    for (let i = 0; i < 20 && result === "verifying"; i++) {
      signal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 250));
      result = await readStatus(service);
    }
    return result;
  }
  return {SERVICE, getService, readReport, readStatus, readPower, requireActive, readRequest, parseRequest, sendLicense};
})();
