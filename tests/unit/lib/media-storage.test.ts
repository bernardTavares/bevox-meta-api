import { describe, it, expect } from "vitest";

import { mediaObjectKey } from "@/lib/media-storage.js";

describe("mediaObjectKey", () => {
  it("builds {tenant_id}/{media_id}", () => {
    expect(mediaObjectKey("org-1", "wamid.ABC")).toBe("org-1/wamid.ABC");
  });
  it("rejects path traversal / empty parts", () => {
    expect(() => mediaObjectKey("", "x")).toThrow();
    expect(() => mediaObjectKey("org-1", "")).toThrow();
    expect(() => mediaObjectKey("org-1", "../escape")).toThrow();
    expect(() => mediaObjectKey("..", "x")).toThrow();
    expect(() => mediaObjectKey("org-1", "..")).toThrow();
  });
});
