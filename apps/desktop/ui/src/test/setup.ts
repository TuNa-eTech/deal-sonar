import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { beforeEach, afterEach } from "vitest";
import { resetMockBackend } from "../lib/mockBackend";

afterEach(() => {
  cleanup();
  resetMockBackend();
});

beforeEach(()=>{localStorage.clear();localStorage.setItem("dealsonar.workspace.screen",JSON.stringify("inbox"));window.history.replaceState(null,"","/#inbox");});
