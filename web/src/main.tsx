import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The service worker makes the app installable and receives notifications. Browsers only allow
// it on HTTPS (or localhost), so over plain http://100.x… it is simply skipped.
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("service worker:", e));
}
