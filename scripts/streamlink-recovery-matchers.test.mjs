import test from "node:test";
import assert from "node:assert/strict";
import { matchesKdlFileButton, isNextPageLabel } from "./streamlink-recovery-matchers.mjs";

const item = { quality: "1080p", codec: "HEVC" };

test("matches exact episode, quality and codec from a KDL filename", () => {
  assert.equal(matchesKdlFileButton("Blossom in Darkness S01E01 2025 WEB-DL 1080p HEVC.mkv", item, "S01E01"), true);
});

test("rejects a different episode", () => {
  assert.equal(matchesKdlFileButton("Blossom in Darkness S01E02 2025 WEB-DL 1080p HEVC.mkv", item, "S01E01"), false);
});

test("rejects a different quality", () => {
  assert.equal(matchesKdlFileButton("Blossom in Darkness S01E01 720p HEVC.mkv", item, "S01E01"), false);
});

test("rejects a different codec", () => {
  assert.equal(matchesKdlFileButton("Blossom in Darkness S01E01 1080p AVC.mkv", item, "S01E01"), false);
});

test("recognizes the observed next-page button label", () => {
  assert.equal(isNextPageLabel("NEXT »"), true);
  assert.equal(isNextPageLabel("NEXT PAGE"), false);
});

test("accepts a file without a visible quality label only after the exact Quality filter was applied", () => {
  assert.equal(matchesKdlFileButton("862.48 MB • S01E17 • Blossom In Darkness 2026 X265 mkv", item, "S01E17", { qualityConfirmed: true }), true);
  assert.equal(matchesKdlFileButton("862.48 MB • S01E17 • Blossom In Darkness 2026 X265 mkv", item, "S01E17"), false);
});

test("recognizes KDL Air's stylized Unicode NEXT button", () => {
  assert.equal(isNextPageLabel("𝖭𝖤𝖷𝖳 »"), true);
});
