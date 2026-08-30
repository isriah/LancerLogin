import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return <main className="welcome"><section><p className="eyebrow">Open-source attendance</p><h1>LancerLogin</h1><p>Finish connecting your own Cloudflare account to start a new installation.</p><a className="button" href="#connect-cloudflare">Start setup</a></section></main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
