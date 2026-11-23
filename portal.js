"use strict";

(() => {
  const $ = id => document.getElementById(id);
  const supported = window.isSecureContext && !!navigator.bluetooth;
  const names = {pending: "待激活", active: "已激活", verifying: "屏幕正在验签", rejected: "设备拒绝了上次授权",
    lowVoltage: "激活时电压不足", noVoltage: "激活时未取得有效电压", controlError:"控制程序校验失败"};
  const volts = mv => (mv / 1000).toFixed(3) + " V";
  let session = null, busy = false;
  function message(text, error = false) {
    $("message").textContent = text;
    $("message").classList.toggle("error", error);
  }
  function render() {
    const connected = !!session?.service && !!session?.device.gatt.connected;
    $("connect").disabled = !supported || busy || connected;
    $("disconnect").hidden = !connected;
    $("refresh").hidden = !connected;
    $("refresh").disabled = busy;
    $("connection").textContent = connected ? "已连接" : "未连接";
    $("mac").textContent = session?.request?.mac || "—";
    $("model").textContent = ({2: "SSD1619 三色", 5: "JD79668 四色"})[session?.request?.model] || "—";
    $("state").textContent = names[session?.state] || "待连接";
    const power = session?.power;
    $("voltage").textContent = power ? (power.mv ? volts(power.mv) : "等待读数") + "（激活需 " + volts(power.minimum) + "）" : (connected && session.state ? "此固件未上报" : "—");
    const canActivate = connected && !busy && ["pending", "rejected", "lowVoltage", "noVoltage"].includes(session.state) && !!session.request;
    $("export").disabled = !canActivate;
    $("import").disabled = !canActivate;
    $("continue").hidden = !connected || session.state !== "active" || !session.hasControl;
  }
  function close(current) {
    if (!current) return;
    current.controller.abort();
    current.device.removeEventListener("gattserverdisconnected", current.onDisconnect);
    if (current.device.gatt.connected) current.device.gatt.disconnect();
    if (session === current) session = null;
    $("license").value = "";
    render();
  }
  async function bounded(current, operation, ms) {
    let timer;
    try {
      return await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => {
          close(current);
          reject(new Error("屏幕响应超时。请重新连接并读取状态。"));
        }, ms);
      })]);
    } finally { clearTimeout(timer); }
  }
  async function action(task) {
    if (busy) return;
    busy = true; render();
    try { await task(); }
    catch (error) { message(error.name === "NotFoundError" ? "未选择屏幕，或缺少配套蓝牙特征。" : error.message, true); }
    finally { busy = false; render(); }
  }
  async function inspect(current) {
    current.state = null; current.request = null; current.power = null; current.hasControl = false; render();
    const {state, failedMv, minimum} = await ELActivation.readReport(current.service);
    current.power = await ELActivation.readPower(current.service);
    const request = state === "verifying" ? null : await ELActivation.readRequest(current.service);
    current.controller.signal.throwIfAborted();
    current.state = state; current.request = request;
    if (state === "active" && !current.power?.controlBoot) {
      try {
        await current.server.getPrimaryService(OMProtocol.SERVICE);
        current.controller.signal.throwIfAborted();
        current.hasControl = true;
      } catch (error) {
        // A missing service is expected for a display running the activation test.
        current.controller.signal.throwIfAborted();
        if (error.name !== "NotFoundError") throw error;
      }
    }
    const guidance = {
      pending: current.power?.mv && current.power.mv < current.power.minimum ?
        `当前板载电压不足（${volts(current.power.mv)}，激活最低 ${volts(current.power.minimum)}）。请稳定供电后重新读取。` :
        "屏幕待激活。请下载请求文件发给发布者。",
      rejected: "设备拒绝了授权。请核对请求文件，并向发布者索取匹配的授权。",
      verifying: "请保持供电，稍后点击“重读状态”。",
      lowVoltage: state === "lowVoltage" && `写入授权时电压不足（${volts(failedMv)}，最低 ${volts(minimum)}）。请稳定供电后重新选择同一授权文件。`,
      noVoltage: "写入授权时未取得有效电压。请保持供电并重读状态，再选择同一授权文件。",
      controlError: "控制程序安装或校验失败。请保持稳定供电并重新上电，仍失败时请核对完整刷机文件。",
      active: current.hasControl ? "屏幕已确认激活。可以进入控制台。" : current.power?.controlBoot ?
        "授权已保存。请断开网页、给屏幕重新上电。首次启动会安装控制程序，待屏幕重新广播后连接控制台。" :
        "本屏授权已通过。当前固件只提供激活服务，控制台需要配套的控制固件。",
    };
    message(guidance[state], ["rejected", "lowVoltage", "noVoltage", "controlError"].includes(state));
  }
  $("connect").addEventListener("click", () => action(async () => {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{services: [ELActivation.SERVICE]}],
      optionalServices: [OMProtocol.SERVICE],
    });
    const current = {device, controller: new AbortController()};
    session = current;
    current.onDisconnect = () => {
      if (session !== current) return;
      close(current); message("蓝牙已断开。重新连接后可读取设备保存的授权状态。");
    };
    device.addEventListener("gattserverdisconnected", current.onDisconnect);
    try {
      const server = await bounded(current, device.gatt.connect().then(server => {
        if (current.controller.signal.aborted) {
          if (!session || session.device !== device) device.gatt.disconnect();
          current.controller.signal.throwIfAborted();
        }
        return server;
      }), 20000);
      current.server = server;
      current.service = await bounded(current, ELActivation.getService(server), 10000);
      await bounded(current, inspect(current), 15000);
    } catch (error) { close(current); throw error; }
  }));
  $("disconnect").addEventListener("click", () => {
    close(session); message("已断开。下次连接时会重新读取设备状态。");
  });
  $("refresh").addEventListener("click", () => action(() => bounded(session, inspect(session), 15000)));
  $("export").addEventListener("click", () => action(async () => {
    const current = session;
    const request = await bounded(current, ELActivation.readRequest(current.service), 15000);
    current.controller.signal.throwIfAborted();
    current.request = request;
    const url = URL.createObjectURL(new Blob([request.data], {type: "application/octet-stream"}));
    const link = document.createElement("a");
    link.href = url; link.download = "ELINK42-" + request.mac.replaceAll(":", "") + ".e42req";
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    message("请求文件已生成。请把它发给固件发布者，并在收到授权后回到这里。");
  }));
  $("import").addEventListener("click", () => $("license").click());
  $("license").addEventListener("change", event => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    action(async () => {
      const current = session;
      if (!current || !current.service) throw new Error("请先连接屏幕。");
      if (file.size !== 226) throw new Error("此文件的长度与授权文件不符。请选择发布者返回的 .e42lic。");
      const data = new Uint8Array(await file.arrayBuffer());
      current.controller.signal.throwIfAborted();
      message("正在写入授权，等待屏幕验签。");
      await bounded(current, ELActivation.sendLicense(current.service, data, current.controller.signal), 45000);
      await bounded(current, inspect(current), 15000);
    });
  });
  render();
  if (!supported) message("此浏览器不支持网页蓝牙。请用桌面 Chrome、Edge 或支持网页蓝牙的 Android 浏览器打开。");
})();
