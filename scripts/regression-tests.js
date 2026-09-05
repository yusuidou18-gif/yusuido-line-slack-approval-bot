import assert from "node:assert/strict";
import { __googleTest } from "../src/google.js";
import { analyzeMessage, buildReplyDraft } from "../src/rules.js";
import { buildSlackMessage } from "../src/slack.js";
import { validateReplyDraft } from "../src/draft.js";

const JST_BASE = new Date("2026-08-25T01:00:00.000Z");

function blockJst(year, month, day, hour) {
  const start = new Date(Date.UTC(year, month - 1, day, hour - 9, 0, 0, 0));
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return {
    summary: "blocked",
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() }
  };
}

function slotsFor(text, events = []) {
  const preference = __googleTest.parseSchedulePreference(text, JST_BASE);
  return __googleTest.buildAvailableSlots(events, preference, JST_BASE);
}

function jstHour(slot) {
  const label = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "numeric",
    hour12: false
  }).format(new Date(slot.start));
  return Number(label.replace(/\D/g, ""));
}

function replyFor(text, availableSlots, preference) {
  const calendarInfo = [
    {
      name: "下村奈生",
      staffName: "下村奈生",
      preference,
      availableSlots
    }
  ];
  const analysis = analyzeMessage(text, { matchedFiles: [{ id: "case" }], case: {} });
  return buildReplyDraft({ text, analysis, config: {}, caseInfo: { matchedFiles: [{ id: "case" }], case: {} }, calendarInfo });
}

{
  const text = "2日水曜日16時30分以降は大丈夫です";
  const preference = __googleTest.parseSchedulePreference(text, JST_BASE);
  const slots = slotsFor(text, [
    blockJst(2026, 9, 2, 10),
    blockJst(2026, 9, 2, 13)
  ]);
  assert.deepEqual(slots.map(jstHour), [17]);
  const reply = replyFor(text, slots, preference);
  assert.match(reply, /9月2日（水）/u);
  assert.match(reply, /16:30以降/);
  assert.match(reply, /17:00-18:00/);
  assert.doesNotMatch(reply, /15:00-16:00/);
}

{
  const text = "2日水曜日16時30分以降は大丈夫です";
  const preference = __googleTest.parseSchedulePreference(text, JST_BASE);
  const slots = slotsFor(text, [blockJst(2026, 9, 2, 17)]);
  assert.equal(slots.length, 0);
  const reply = replyFor(text, slots, preference);
  assert.match(reply, /自動候補が見つかりません/);
}

{
  const text = "2日なら大丈夫です";
  const slots = slotsFor(text, [
    blockJst(2026, 9, 2, 10),
    blockJst(2026, 9, 2, 13)
  ]);
  assert.deepEqual(slots.map(jstHour), [15, 17]);
}

{
  const slots = slotsFor("17時でお願いします", []);
  assert.ok(slots.some((slot) => jstHour(slot) === 17));
}

{
  const slots = slotsFor("17時でお願いします", [blockJst(2026, 8, 26, 17)]);
  assert.ok(!slots.some((slot) => slot.start === blockJst(2026, 8, 26, 17).start.dateTime));
}

{
  const text = "2日水曜日16時半以降は大丈夫です";
  const slots = slotsFor(text, [
    blockJst(2026, 9, 2, 10),
    blockJst(2026, 9, 2, 13)
  ]);
  assert.deepEqual(slots.map(jstHour), [17]);
}

{
  const text = "2日水曜日16時までなら大丈夫です";
  const slots = slotsFor(text, [
    blockJst(2026, 9, 2, 10),
    blockJst(2026, 9, 2, 13)
  ]);
  assert.deepEqual(slots.map(jstHour), [15]);
}

{
  const preference = __googleTest.parseSchedulePreference("来週土曜日午後なら大丈夫です", JST_BASE);
  assert.deepEqual(preference.explicitDates, ["2026-09-05"]);
  const slots = __googleTest.buildAvailableSlots([], preference, JST_BASE);
  assert.deepEqual(slots.map(jstHour).slice(0, 3), [13, 15, 17]);
}

{
  const slots = slotsFor("日曜日希望です", []);
  assert.equal(slots.length, 0);
}

{
  const message = buildSlackMessage(
    { slack: { channelId: "C1", presidentUserId: "U_PRESIDENT", officeUserIds: [], staffUserIds: {} } },
    {
      id: "approval_test",
      draft: { id: "draft_test", version: 1 },
      customerName: "未確認",
      caseId: "未確認",
      customerType: "未確認",
      staffName: "未確認",
      caseStatus: "未確認",
      urgency: "中",
      presidentRequired: false,
      reason: "test",
      customerMessage: "2日なら大丈夫です",
      replyDraft: "候補です",
      approvals: {}
    }
  );
  const header = message.blocks[0].text.text;
  const approverBlock = message.blocks.find((block) =>
    block.text?.text?.startsWith("*承認者:*")
  );
  const text = JSON.stringify(message);
  assert.doesNotMatch(header, /U_PRESIDENT/);
  assert.doesNotMatch(approverBlock.text.text, /・社長/);
  assert.doesNotMatch(text, /lineUserId|\"u\":/);
}

{
  const validation = validateReplyDraft("Google Driveを確認し、案件ID: A-123 を見ました。ありがとうございます。");
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.includes("社内情報")));
}

{
  const validation = validateReplyDraft("お問い合わせありがとうございます。\n内容を確認いたしました。\n担当者が内容を確認いたします。\n確認のうえ、次のご案内をお送りいたします。");
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.includes("一般的")));
}

{
  const preference = __googleTest.parseSchedulePreference("トイレ交換の見積をお願いします。土曜日の午後希望です", JST_BASE);
  const slots = slotsFor("トイレ交換の見積をお願いします。土曜日の午後希望です", []);
  const reply = replyFor("トイレ交換の見積をお願いします。土曜日の午後希望です", slots, preference);
  assert.match(reply, /トイレ/);
  assert.match(reply, /お見積り|見積/);
  assert.match(reply, /土曜日|土曜/);
  assert.match(reply, /・/);
  assert.doesNotMatch(reply, /担当者が内容を確認いたします/);
  assert.doesNotMatch(reply, /下村|菅野/);
}

{
  const preference = __googleTest.parseSchedulePreference("日曜日に現地調査をお願いできますか？", JST_BASE);
  const reply = replyFor("日曜日に現地調査をお願いできますか？", [], preference);
  assert.match(reply, /日曜・月曜は定休日/);
  assert.match(reply, /火曜から土曜/);
  assert.doesNotMatch(reply, /工事日を確定|確約/);
}

{
  const analysis = analyzeMessage("見積が高いので値引きできますか？", { matchedFiles: [{ id: "case" }], case: { estimateStatus: "提出済み" } });
  const reply = buildReplyDraft({ text: "見積が高いので値引きできますか？", analysis, config: {}, caseInfo: { matchedFiles: [{ id: "case" }], case: { estimateStatus: "提出済み" } }, calendarInfo: [] });
  assert.match(reply, /費用|金額|お見積り/);
  assert.match(reply, /確約できません/);
  assert.doesNotMatch(reply, /値引きできます|割引します|無料にします/);
}

{
  const analysis = analyzeMessage("工事後なのに直っていません。どうなってるんですか", { matchedFiles: [{ id: "case" }], case: {} });
  const reply = buildReplyDraft({ text: "工事後なのに直っていません。どうなってるんですか", analysis, config: {}, caseInfo: { matchedFiles: [{ id: "case" }], case: {} }, calendarInfo: [] });
  assert.match(reply, /申し訳ございません/);
  assert.match(reply, /対応方針/);
  assert.doesNotMatch(reply, /しかし|ただし|お客様/);
}

{
  const validation = validateReplyDraft("お問い合わせありがとうございます。\n下村が確認してご案内いたします。");
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.includes("社内情報")));
}

console.log("OK: regression tests passed");
