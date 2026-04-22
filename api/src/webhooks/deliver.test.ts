import { describe, it, expect } from "vitest";
import { mergeDeliverTarget, type DeliverSummary } from "./deliver";

/**
 * Pure-function tests for the Deliver-stage counter merge policy. These
 * assert the bug fix tracked in platform-56: a target that fails and
 * retries must only count ONCE on its terminal outcome, not once per
 * attempt.
 */

function seed(total: number): DeliverSummary {
  return {
    event_id: "evt_test",
    event_type: "document.delivered",
    targets_total: total,
    targets: {},
    targets_delivered: 0,
    targets_failed: 0,
  };
}

describe("mergeDeliverTarget — per-target terminal counting", () => {
  it("first-attempt success counts as one delivery", () => {
    const { summary, isFinal } = mergeDeliverTarget(seed(1), {
      targetId: "t1",
      succeeded: true,
      isFinalAttempt: false,
      httpStatus: 200,
      attempt: 1,
    });
    expect(summary.targets_delivered).toBe(1);
    expect(summary.targets_failed).toBe(0);
    expect(summary.targets.t1?.status).toBe("delivered");
    expect(summary.targets.t1?.attempts).toBe(1);
    expect(isFinal).toBe(true);
  });

  it("intermediate failure bumps attempts but does NOT count toward failed", () => {
    const { summary, isFinal } = mergeDeliverTarget(seed(1), {
      targetId: "t1",
      succeeded: false,
      isFinalAttempt: false,
      httpStatus: 502,
      attempt: 3,
    });
    expect(summary.targets_delivered).toBe(0);
    expect(summary.targets_failed).toBe(0);
    expect(summary.targets.t1?.status).toBe("in_flight");
    expect(summary.targets.t1?.attempts).toBe(3);
    expect(isFinal).toBe(false);
  });

  it("final failed attempt counts as one failure (not once per attempt)", () => {
    let s = seed(1);
    // 11 intermediate failures — none should count.
    for (let a = 1; a <= 11; a++) {
      s = mergeDeliverTarget(s, {
        targetId: "t1",
        succeeded: false,
        isFinalAttempt: false,
        httpStatus: 502,
        attempt: a,
      }).summary;
    }
    expect(s.targets_failed).toBe(0);

    const final = mergeDeliverTarget(s, {
      targetId: "t1",
      succeeded: false,
      isFinalAttempt: true,
      httpStatus: 502,
      attempt: 12,
    });
    expect(final.summary.targets_failed).toBe(1);
    expect(final.summary.targets.t1?.attempts).toBe(12);
    expect(final.isFinal).toBe(true);
  });

  it("fails, retries, eventually succeeds → counts as delivered, not failed", () => {
    let s = seed(1);
    // First attempt fails.
    s = mergeDeliverTarget(s, {
      targetId: "t1",
      succeeded: false,
      isFinalAttempt: false,
      httpStatus: 503,
      attempt: 1,
    }).summary;
    expect(s.targets_delivered).toBe(0);
    expect(s.targets_failed).toBe(0);
    expect(s.targets.t1?.status).toBe("in_flight");

    // Retry succeeds.
    const result = mergeDeliverTarget(s, {
      targetId: "t1",
      succeeded: true,
      isFinalAttempt: false,
      httpStatus: 200,
      attempt: 2,
    });
    expect(result.summary.targets_delivered).toBe(1);
    expect(result.summary.targets_failed).toBe(0);
    expect(result.summary.targets.t1?.status).toBe("delivered");
    expect(result.summary.targets.t1?.attempts).toBe(2);
    expect(result.isFinal).toBe(true);
  });

  it("multi-target: stage does not finalise until every target settles", () => {
    let s = seed(3);

    // t1 delivers on first attempt
    s = mergeDeliverTarget(s, {
      targetId: "t1",
      succeeded: true,
      isFinalAttempt: false,
      httpStatus: 200,
      attempt: 1,
    }).summary;

    // t2 fails mid-retry
    s = mergeDeliverTarget(s, {
      targetId: "t2",
      succeeded: false,
      isFinalAttempt: false,
      httpStatus: 500,
      attempt: 2,
    }).summary;

    // Not final — t2 still in flight and t3 hasn't shown up yet.
    let settled = s.targets_delivered + s.targets_failed;
    expect(s.targets_total).toBe(3);
    expect(settled).toBe(1);

    // t3 succeeds
    s = mergeDeliverTarget(s, {
      targetId: "t3",
      succeeded: true,
      isFinalAttempt: false,
      httpStatus: 200,
      attempt: 1,
    }).summary;
    settled = s.targets_delivered + s.targets_failed;
    expect(settled).toBe(2); // t1 + t3

    // t2 exhausts retries
    const final = mergeDeliverTarget(s, {
      targetId: "t2",
      succeeded: false,
      isFinalAttempt: true,
      httpStatus: 500,
      attempt: 12,
    });
    expect(final.summary.targets_delivered).toBe(2);
    expect(final.summary.targets_failed).toBe(1);
    expect(final.isFinal).toBe(true);
  });

  it("attempts is tracked as a high-water mark (out-of-order reorder safe)", () => {
    let s = seed(1);
    s = mergeDeliverTarget(s, {
      targetId: "t1",
      succeeded: false,
      isFinalAttempt: false,
      httpStatus: 502,
      attempt: 5,
    }).summary;
    expect(s.targets.t1?.attempts).toBe(5);

    // An older attempt arrives (shouldn't happen but let's be defensive).
    s = mergeDeliverTarget(s, {
      targetId: "t1",
      succeeded: false,
      isFinalAttempt: false,
      httpStatus: 500,
      attempt: 2,
    }).summary;
    expect(s.targets.t1?.attempts).toBe(5);
  });

  it("zero-target stage doesn't finalise via this path (motor writes it directly)", () => {
    // With targets_total: 0 the motor writes the stage as `ok` immediately,
    // never calling mergeDeliverTarget. But if it somehow was called with
    // total=0 we shouldn't claim finality from an empty map.
    const s = seed(0);
    const result = mergeDeliverTarget(s, {
      targetId: "t1",
      succeeded: true,
      isFinalAttempt: false,
      httpStatus: 200,
      attempt: 1,
    });
    expect(result.isFinal).toBe(false);
  });

  it("inflated counter bug guard: 12 attempts of 1 retrying-then-succeeding target never exceeds 1", () => {
    // This models the exact bug the task describes. With the OLD code,
    // every attempt bumped targets_delivered / targets_failed, so this
    // loop would land with targets_delivered = 1 and targets_failed = 11.
    // With the new per-target model the only event that counts is the
    // final terminal outcome.
    let s = seed(1);
    for (let a = 1; a <= 11; a++) {
      s = mergeDeliverTarget(s, {
        targetId: "t1",
        succeeded: false,
        isFinalAttempt: false,
        httpStatus: 502,
        attempt: a,
      }).summary;
    }
    const final = mergeDeliverTarget(s, {
      targetId: "t1",
      succeeded: true,
      isFinalAttempt: false,
      httpStatus: 200,
      attempt: 12,
    });
    expect(final.summary.targets_delivered).toBe(1);
    expect(final.summary.targets_failed).toBe(0);
    expect(final.isFinal).toBe(true);
  });
});
