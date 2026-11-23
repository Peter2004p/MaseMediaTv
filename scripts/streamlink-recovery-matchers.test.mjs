import test from "node:test";
import assert from "node:assert/strict";
import { matchesKdlFileButton, isNextPageLabel, stripSourceLabelSuffix, isKdlEpisodeRowLabel, matchesReleaseTag, isRecoverableExpiredDrama } from "./streamlink-recovery-matchers.mjs";

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

test("accepts KDL episode-list rows without codec or quality labels only after the quality filter was applied", () => {
  assert.equal(matchesKdlFileButton("179.86 MB • S01E08 • @KLandd Blossom In Darkness", item, "S01E08", { qualityConfirmed: true }), true);
  assert.equal(matchesKdlFileButton("179.86 MB • S01E08 • @KLandd Blossom In Darkness", item, "S01E08"), false);
  assert.equal(matchesKdlFileButton("179.86 MB • S01E09 • @KLandd Blossom In Darkness", item, "S01E08", { qualityConfirmed: true }), false);
});

test("recognizes KDL Air's stylized Unicode NEXT button", () => {
  assert.equal(isNextPageLabel("𝖭𝖤𝖷𝖳 »"), true);
});

test("strips provider suffixes without changing the drama title", () => {
  for (const suffix of ["IQ", "iQIYI", "Youk", "Youku", "VIK", "VIKI", "Viki", "KDLand", "KLandd", "KDLAir"]) {
    assert.equal(stripSourceLabelSuffix("The Lament Of Autumn " + suffix), "The Lament Of Autumn");
  }
  assert.equal(stripSourceLabelSuffix("Blossom in Darkness"), "Blossom in Darkness");
});

test("recognizes KDL episode rows even when there is no NEXT pagination button", () => {
  assert.equal(isKdlEpisodeRowLabel("179.86 MB • S01E17 • Blossom in Darkness"), true);
  assert.equal(isKdlEpisodeRowLabel("S02E03 - 1080p HEVC"), true);
  assert.equal(isKdlEpisodeRowLabel("NEXT »"), false);
  assert.equal(isKdlEpisodeRowLabel("No matching files"), false);
});

test("requires the exact drama title in a KDL episode row when title metadata is available", () => {
  const exact = { title: "Blossom in Darkness IQ", quality: "1080p", codec: "HEVC" };
  assert.equal(matchesKdlFileButton("179.86 MB • S01E08 • @KLandd Blossom In Darkness", exact, "S01E08", { qualityConfirmed: true }), true);
  assert.equal(matchesKdlFileButton("179.86 MB • S01E08 • Another Drama", exact, "S01E08", { qualityConfirmed: true }), false);
});

test("matches the exact release/provider suffix when the old URL records one", () => {
  assert.equal(matchesReleaseTag("567.60 MB • S01E40 • Tigers Sniff The Rose X264 WETV mkv", "WETV"), true);
  assert.equal(matchesReleaseTag("305.69 MB • S01E40 • Tigers Sniff The Rose X264 VIKI mkv", "WETV"), false);
  assert.equal(matchesReleaseTag("305.69 MB • S01E40 • Tigers Sniff The Rose X264 VIKI mkv", "VIKI"), true);
  assert.equal(matchesReleaseTag("305.69 MB • S01E40 • Tigers Sniff The Rose X264 VIKI mkv", ""), true);
});

test("queues only confirmed-expired dramas; skips expired movies and unexpired links", () => {
  assert.equal(isRecoverableExpiredDrama({ kind: "drama" }, { expired: true }), true);
  assert.equal(isRecoverableExpiredDrama({ kind: "movie" }, { expired: true }), false);
  assert.equal(isRecoverableExpiredDrama({ kind: "drama" }, { expired: false }), false);
  assert.equal(isRecoverableExpiredDrama({ kind: "movie" }, { expired: false }), false);
});
