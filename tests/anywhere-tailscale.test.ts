import { describe, expect, it } from "vitest";
import { isValidRendezvous } from "../extensions/anywhere/config.ts";

describe("Anywhere companion rendezvous validation", () => {
  it("accepts only v2 loopback registration metadata", () => {
    expect(isValidRendezvous({
      version: 2,
      process_epoch: "epoch-1",
      internal_port: 43123,
      registration_token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    })).toBe(true);
  });

  it("rejects stale, public, or malformed rendezvous data", () => {
    expect(isValidRendezvous({
      version: 1,
      process_epoch: "epoch-1",
      internal_port: 43123,
      registration_token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    })).toBe(false);
    expect(isValidRendezvous({
      version: 2,
      process_epoch: "epoch-1",
      internal_port: 0,
      registration_token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    })).toBe(false);
    expect(isValidRendezvous({
      version: 2,
      process_epoch: "epoch-1",
      internal_port: 43123,
      registration_token: "short",
      extra: true,
    })).toBe(false);
  });
});
