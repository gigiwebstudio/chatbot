// Embed snippet for a clinic's own website. Usage:
//
//   <script src="https://<this-app's-domain>/embed.js" data-clinic-id="<uuid>"></script>
//
// Optional attributes: data-clinic-name (shown in the widget header),
// data-vertical (which quick-reply set to show - 'clinic' or 'law_firm',
// see QUICK_REPLIES_BY_VERTICAL in ChatWidget.tsx; defaults to 'clinic'),
// data-base-url (override if this script is ever served from a different
// domain than the app itself - normally derived from the script's own src).
//
// Loads the chat widget in an iframe pointed at /widget on this app's own
// domain, so the widget's own fetches to /api/chat stay same-origin - no
// CORS setup needed on the client's site. The iframe is resized between a
// small closed-button box and the full open-panel box via postMessage from
// the widget (see the "resize" listener below), so the host page's own
// content isn't blocked by an iframe-sized click-through area when the
// widget is closed, which is most of the time.
(function () {
  var thisScript =
    document.currentScript ||
    (function () {
      var scripts = document.getElementsByTagName("script");
      return scripts[scripts.length - 1];
    })();

  var clinicId = thisScript.getAttribute("data-clinic-id");
  if (!clinicId) {
    console.error(
      "[clinic-chat-widget] embed.js is missing a data-clinic-id attribute - the widget will not load."
    );
    return;
  }

  var clinicName = thisScript.getAttribute("data-clinic-name") || "";
  var vertical = thisScript.getAttribute("data-vertical") || "";
  var baseUrl = thisScript.getAttribute("data-base-url");
  if (!baseUrl) {
    baseUrl = thisScript.src.replace(/\/embed\.js(?:[?#].*)?$/, "");
  }

  var params = new URLSearchParams({ clinicId: clinicId });
  if (clinicName) params.set("clinicName", clinicName);
  if (vertical) params.set("vertical", vertical);

  var iframe = document.createElement("iframe");
  iframe.src = baseUrl + "/widget?" + params.toString();
  iframe.title = "Chat";
  iframe.style.position = "fixed";
  iframe.style.bottom = "0";
  iframe.style.right = "0";
  iframe.style.border = "none";
  iframe.style.background = "transparent";
  iframe.style.colorScheme = "normal";
  // Max int32 - above any z-index the host page is likely to use, short of
  // another widget doing the same thing.
  iframe.style.zIndex = "2147483000";

  var CLOSED_SIZE = { width: "96px", height: "96px" };
  var OPEN_SIZE = { width: "400px", height: "620px" };

  function applySize(size) {
    iframe.style.width = "min(" + size.width + ", 100vw)";
    iframe.style.height = "min(" + size.height + ", 100vh)";
  }

  applySize(CLOSED_SIZE);

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.source !== "clinic-chat-widget" || data.type !== "resize") {
      return;
    }
    // Only react to messages from the iframe we created, not some unrelated
    // same-page frame that happens to post a similarly-shaped message.
    if (event.source !== iframe.contentWindow) return;
    applySize(data.open ? OPEN_SIZE : CLOSED_SIZE);
  });

  document.body.appendChild(iframe);
})();
