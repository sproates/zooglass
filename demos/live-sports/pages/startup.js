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
    !window.fetch ||
    !window.AbortController ||
    !window.requestAnimationFrame ||
    !("noModule" in document.createElement("script"))
  )
    return;
  status.textContent = "Loading Matchroom…";
  var script = document.createElement("script");
  script.type = "module";
  script.src = "/live-sports/src/app.js";
  script.onerror = function () {
    status.textContent =
      "Matchroom assets could not load. Check the demo server and reload this page.";
  };
  var timer = setTimeout(function () {
    if (!status.hidden)
      status.textContent =
        "Matchroom could not start. Check the connection to the demo server and reload.";
  }, 10000);
  script.onload = function () {
    clearTimeout(timer);
    if (!status.hidden)
      status.textContent =
        "Matchroom could not start. Check the demo server and reload this page.";
  };
  document.body.appendChild(script);
})();
