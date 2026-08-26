import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TrackerApp } from "./App";

createRoot(document.getElementById("root")!).render(<StrictMode><TrackerApp /></StrictMode>);
