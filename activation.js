"use strict";

// The browser transports public requests and signed envelopes. Secrets stay off the site.
const ELActivation = (() => {
  const SERVICE = "93adab00-76ce-468d-8bd8-f2420ecc4172";
  const STATUS  = "93adab01-76ce-468d-8bd8-f2420ecc4172";
  const REQUEST = "93adab02-76ce-468d-8bd8-f2420ecc4172";
  const LICENSE = "93adab03-76ce-468d-8bd8-f2420ecc4172";
  const STATES = ["pending", "active", "verifying", "rejected"];

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
  async function readStatus(service) {
    const c = await service.getCharacteristic(STATUS);
    const value = bytes(await c.readValue());
    if (value.length !== 2 || value[0] !== 1 || value[1] >= STATES.length)
      throw new Error("无法识别设备授权状态。请核对固件版本。");
    return STATES[value[1]];
  }
  async function requireActive(server) {
    const state = await readStatus(await getService(server));
    if (state !== "active") throw new Error("屏幕尚未确认激活。请先返回激活页面。");
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
    return readStatus(service);
  }
  return {SERVICE, getService, readStatus, requireActive, readRequest, parseRequest, sendLicense};
})();
