// Deliberately classic script: the initial requirements remain visible without modules.
(function () {
  var status = document.getElementById("startup");
  var ua = navigator.userAgent;
  var chrome = ua.match(/(?:Chrome|Chromium)\/(\d+)/);
  var firefox = ua.match(/Firefox\/(\d+)/);
  var safari = ua.match(/Version\/(\d+).*Safari/);
  var ios = ua.match(/(?:CPU (?:iPhone )?OS|iPhone OS) (\d+)_/);
  var supportedVersion = chrome
    ? Number(chrome[1]) >= 120
    : firefox
      ? Number(firefox[1]) >= 121
      : safari
        ? Number(safari[1]) >= 17
        : true;
  if (
    (ios && Number(ios[1]) < 17) ||
    !supportedVersion ||
    !window.WebSocket ||
    !window.ResizeObserver ||
    !window.fetch ||
    !window.AbortController ||
    !window.requestAnimationFrame ||
    !("noModule" in document.createElement("script"))
  ) {
    return;
  }
  status.textContent = "Loading Fleet viewer…";
  var script = document.createElement("script");
  script.type = "module";
  script.src = "/driving/bootstrap.js";
  var timer = setTimeout(failed, 10000);
  function failed() {
    clearTimeout(timer);
    if (!status.hidden) {
      document.getElementById("connection").textContent = "Unavailable";
      status.textContent =
        "Fleet viewer could not start. Check the demo server and reload this page.";
    }
  }
  script.onerror = failed;
  window.addEventListener(
    "fleet-ready",
    function () {
      clearTimeout(timer);
      status.hidden = true;
    },
    { once: true },
  );
  window.addEventListener("fleet-startup-failed", failed, { once: true });
  document.body.appendChild(script);
})();
