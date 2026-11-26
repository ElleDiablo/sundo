/**
 * Tests for when a guest sends input (on change, ≤ 10/s, keepalive once a second) and for
 * measuring the round trip from the host's acks.
 */
import { describe, expect, it } from "vitest";
import { InputSender, LatencyStats } from "./inputSender.ts";

const none = { up: false, down: false, left: false, right: false };
const up = { ...none, up: true };
const left = { ...none, left: true };

describe("InputSender", () => {
  it("sends the first keys straight away, numbered from 1", () => {
    expect(new InputSender().update(up, 0)).toEqual({ seq: 1, ...up });
  });

  it("doesn't repeat unchanged keys until the 1 s keepalive", () => {
    const s = new InputSender();
    s.update(up, 0);
    expect(s.update(up, 500)).toBeUndefined();
    expect(s.update(up, 1000)).toEqual({ seq: 2, ...up });
  });

  it("doesn't hold a key press back because a keepalive just went out", () => {
    const s = new InputSender();
    s.update(none, 0);
    expect(s.update(none, 1000)).toEqual({ seq: 2, ...none }); // keepalive
    expect(s.update(up, 1020)).toEqual({ seq: 3, ...up }); // 20 ms later, sent at once
  });

  it("remembers the last message sent, for prediction (NET-01)", () => {
    const s = new InputSender();
    expect(s.current).toBeUndefined();
    s.update(up, 0);
    s.update(left, 40); // held back by the 100 ms gap: not sent yet, so not current either
    expect(s.current).toEqual({ seq: 1, keys: up });
    s.update(left, 100);
    expect(s.current).toEqual({ seq: 2, keys: left });
  });

  it("sends a change at most every 100 ms, but never loses it", () => {
    const s = new InputSender();
    s.update(up, 0);
    expect(s.update(left, 40)).toBeUndefined(); // too soon
    expect(s.update(left, 99)).toBeUndefined();
    expect(s.update(left, 100)).toEqual({ seq: 2, ...left }); // the held change goes out
  });

  it("measures the round trip once per acknowledged message", () => {
    const s = new InputSender();
    s.update(up, 1000); // seq 1
    s.update(left, 1100); // seq 2
    expect(s.acked(2, 1180)).toBe(80);
    expect(s.acked(2, 1280)).toBeUndefined(); // the next snapshot repeats the ack
    expect(s.acked(1, 1300)).toBeUndefined(); // older, already covered
  });
});

describe("LatencyStats", () => {
  it("reports the median and the 95th percentile of the recent samples", () => {
    const stats = new LatencyStats(100);
    expect(stats.percentile(0.5)).toBeUndefined();
    for (let ms = 1; ms <= 100; ms++) stats.add(ms);
    expect(stats.percentile(0.5)).toBe(51);
    expect(stats.percentile(0.95)).toBe(96);
  });

  it("forgets the oldest samples", () => {
    const stats = new LatencyStats(3);
    for (const ms of [500, 10, 20, 30]) stats.add(ms);
    expect(stats.count).toBe(3);
    expect(stats.percentile(1)).toBe(30);
  });
});
