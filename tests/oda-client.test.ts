import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { OdaClient } from "../src/oda-client.js";

const apiResponse = (
  status: number,
  json: ReturnType<typeof vi.fn> = vi.fn(),
  body = "",
) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { getSetCookie: () => [] },
  json,
  text: vi.fn().mockResolvedValue(body),
});

describe("OdaClient cookie permissions", () => {
  it("repairs an existing cookie file to mode 0600 before loading it", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oda-cookie-"));
    const cookiePath = path.join(tempDir, "cookies.json");
    fs.writeFileSync(cookiePath, JSON.stringify({ csrftoken: "secret" }), {
      mode: 0o666,
    });
    fs.chmodSync(cookiePath, 0o666);

    try {
      const client = new OdaClient(cookiePath);
      expect(client.getCsrfToken()).toBe("secret");
      expect(fs.statSync(cookiePath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("repairs an existing cookie file to mode 0600 when saving", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oda-cookie-"));
    const cookiePath = path.join(tempDir, "cookies.json");
    fs.writeFileSync(cookiePath, "{}", { mode: 0o600 });

    try {
      const client = new OdaClient(cookiePath);
      fs.chmodSync(cookiePath, 0o666);
      client.saveCookies();
      expect(fs.statSync(cookiePath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("OdaClient API error handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an unsuccessful frequent-products order-list response before parsing JSON", async () => {
    const json = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(apiResponse(401, json, "not authenticated")),
    );
    const client = new OdaClient("/nonexistent/cookies.json");

    await expect(client.getFrequentProducts()).rejects.toThrow(
      /frequent products.*order list.*HTTP 401.*not authenticated/i,
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects an unsuccessful frequent-products order-detail response before parsing JSON", async () => {
    const detailJson = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          apiResponse(
            200,
            vi.fn().mockResolvedValue({
              results: [{ orders: [{ order_number: "ORDER-1" }] }],
              has_more: false,
            }),
          ),
        )
        .mockResolvedValueOnce(apiResponse(503, detailJson, "try later")),
    );
    const client = new OdaClient("/nonexistent/cookies.json");

    await expect(client.getFrequentProducts()).rejects.toThrow(
      /frequent products.*order ORDER-1.*HTTP 503.*try later/i,
    );
    expect(detailJson).not.toHaveBeenCalled();
  });

  it("stops when frequent-products pagination repeats a URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          apiResponse(
            200,
            vi.fn().mockResolvedValue({
              results: [],
              has_more: true,
              get_more_url: "https://oda.com/api/v1/orders/?before=1",
            }),
          ),
        )
        .mockResolvedValueOnce(
          apiResponse(
            200,
            vi.fn().mockResolvedValue({
              results: [],
              has_more: true,
              get_more_url: "https://oda.com/api/v1/orders/?before=1",
            }),
          ),
        ),
    );
    const client = new OdaClient("/nonexistent/cookies.json");

    await expect(client.getFrequentProducts()).rejects.toThrow(
      /pagination repeated.*before=1/i,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects unsuccessful cart recommendations before parsing JSON", async () => {
    const json = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(apiResponse(403, json, "forbidden")),
    );
    const client = new OdaClient("/nonexistent/cookies.json");

    await expect(client.getCartRecommendations()).rejects.toThrow(
      /cart recommendations.*HTTP 403.*forbidden/i,
    );
    expect(json).not.toHaveBeenCalled();
  });
});
