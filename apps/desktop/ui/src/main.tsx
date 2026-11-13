import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles/app.css";
import "./styles/components.css";
import "./styles/work-screens.css";
import "./styles/management.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
