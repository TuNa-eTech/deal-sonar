import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { resetMockBackend } from "../lib/mockBackend";

afterEach(() => {
  cleanup();
  resetMockBackend();
});
