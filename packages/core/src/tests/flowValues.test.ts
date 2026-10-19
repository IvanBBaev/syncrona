// SPDX-License-Identifier: GPL-3.0-or-later
import { gzipSync } from "node:zlib";
import { detectFlowValues, encodeFlowValues, FLOW_VALUES_MAX_INFLATED } from "../flow/flowValues.js";

// Produced once with node's own gzip, so the decoder is checked against bytes
// the encoder under test did not write.
const LITERAL_GZIP = "H4sIAAAAAAAAE4uuVspLzE1VslIqSUzKSY0Hc3SUyhJzSkGCmXnJmSmpeSVKtbEAESPijSoAAAA=";
const LITERAL_VALUE = [{ name: "table_name", value: "incident" }];

const gzipBase64 = (text: string): string => gzipSync(Buffer.from(text, "utf8")).toString("base64");

describe("detectFlowValues", () => {
  it.each([[""], ["   \n"], ["\ufeff"], [null], [undefined]])("reads %p as empty", (raw) => {
    const result = detectFlowValues(raw);
    expect(result).toMatchObject({ format: "empty", decoded: true, value: null });
  });

  it("reads plain JSON and counts the raw bytes", () => {
    expect(detectFlowValues('\ufeff [{"name":"é"}] ')).toEqual({
      format: "json",
      decoded: true,
      value: [{ name: "é" }],
      bytes: 20,
    });
  });

  it("reads a non-string cell through its text", () => {
    expect(detectFlowValues(5)).toMatchObject({ format: "json", value: 5 });
  });

  it("inflates base64 + gzip JSON", () => {
    expect(detectFlowValues(LITERAL_GZIP)).toEqual({
      format: "base64-gzip-json",
      decoded: true,
      value: LITERAL_VALUE,
      bytes: LITERAL_GZIP.length,
    });
  });

  it("ignores line breaks inside the base64", () => {
    const wrapped = LITERAL_GZIP.replace(/(.{16})/g, "$1\n");
    expect(detectFlowValues(wrapped)).toMatchObject({ format: "base64-gzip-json", value: LITERAL_VALUE });
  });

  it("reports base64 that is not gzip as unknown", () => {
    expect(detectFlowValues("YWJjZA==")).toMatchObject({
      format: "unknown",
      decoded: false,
      reason: "not JSON and not base64 + gzip JSON",
    });
  });

  it("reports text that is neither JSON nor base64 as unknown", () => {
    expect(detectFlowValues("{not json")).toMatchObject({ format: "unknown", decoded: false, bytes: 9 });
  });

  it("reports gzip that is not JSON", () => {
    expect(detectFlowValues(gzipBase64("plain text"))).toMatchObject({
      format: "unknown",
      decoded: false,
      reason: "base64 + gzip payload is not JSON",
    });
  });

  it("reports truncated gzip without throwing", () => {
    const truncated = Buffer.from(LITERAL_GZIP, "base64").subarray(0, 20).toString("base64");
    const result = detectFlowValues(truncated);
    expect(result.decoded).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringMatching(/^base64 \+ gzip payload did not inflate: /) });
  });

  it("refuses to inflate past the size bound", () => {
    const huge = gzipBase64(JSON.stringify(" ".repeat(FLOW_VALUES_MAX_INFLATED + 1)));
    const result = detectFlowValues(huge);
    expect(result).toMatchObject({ format: "unknown", decoded: false });
    expect(result).toMatchObject({ reason: expect.stringMatching(/did not inflate/) });
  });
});

describe("encodeFlowValues", () => {
  const value = { inputs: [{ name: "short_description", value: "{{trigger.current.number}}", children: [] }] };

  it.each(["json", "base64-gzip-json"] as const)("round-trips through %s", (format) => {
    const encoded = encodeFlowValues(value, format);
    expect(detectFlowValues(encoded)).toMatchObject({ format, decoded: true, value });
  });

  it("writes gzip as base64 starting with the gzip magic", () => {
    expect(encodeFlowValues(value, "base64-gzip-json").startsWith("H4sI")).toBe(true);
  });

  it("encodes empty as an empty column", () => {
    expect(encodeFlowValues(null, "empty")).toBe("");
    expect(detectFlowValues(encodeFlowValues(null, "empty"))).toMatchObject({ format: "empty", value: null });
  });
});
