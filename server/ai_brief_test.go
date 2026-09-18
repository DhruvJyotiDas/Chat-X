package main

import "testing"

func TestNormalizeDailyBriefCapsOutput(t *testing.T) {
	items := make([]aiBriefItem, 7)
	watchouts := []string{"1", "2", "3", "4", "5"}
	brief := aiDailyBrief{Priorities: items, FollowUps: items, Watchouts: watchouts}
	normalizeDailyBrief(&brief)
	if len(brief.Priorities) != 5 || len(brief.FollowUps) != 5 || len(brief.Watchouts) != 4 {
		t.Fatalf("unexpected caps: %d priorities, %d follow-ups, %d watchouts", len(brief.Priorities), len(brief.FollowUps), len(brief.Watchouts))
	}
}

func TestFilterBriefItemsRejectsInventedSources(t *testing.T) {
	items := []aiBriefItem{
		{Title: "Grounded", SourceRef: "source:task:known"},
		{Title: "Invented", SourceRef: "source:task:missing"},
	}
	got := filterBriefItems(items, map[string]struct{}{"source:task:known": {}})
	if len(got) != 1 || got[0].Title != "Grounded" {
		t.Fatalf("unexpected filtered items: %#v", got)
	}
}

func TestFallbackDailyBriefUsesOnlyGroundedSourceLines(t *testing.T) {
	contextText := `RECENT CONVERSATION MESSAGES
source:message:m1 Project chat | Priya | Can you send the report?
OPEN TASKS
source:task:t1 Send the report | 2026-09-17 10:00 UTC
OPEN REMINDERS
source:reminder:r1 Check the deployment | no reminder time
UPCOMING CALENDAR EVENTS
source:calendar:e1 Weekly review | 2026-09-17 11:00-11:30 | Room 2`
	brief := fallbackDailyBrief(contextText, 4)
	if brief.GeneratedBy != "grounded_fallback" || brief.Notice == "" || brief.SourceCount != 4 {
		t.Fatalf("unexpected fallback metadata: %+v", brief)
	}
	if len(brief.Priorities) != 2 || brief.Priorities[0].SourceRef != "source:task:t1" || brief.Priorities[1].SourceRef != "source:calendar:e1" {
		t.Fatalf("unexpected fallback priorities: %#v", brief.Priorities)
	}
	if len(brief.FollowUps) != 2 || brief.FollowUps[0].SourceRef != "source:message:m1" || brief.FollowUps[1].SourceRef != "source:reminder:r1" {
		t.Fatalf("unexpected fallback follow-ups: %#v", brief.FollowUps)
	}
}

func TestDailyBriefFlightsCoalesceSameUserAndDate(t *testing.T) {
	key := "test-user:2099-01-01"
	first, leader := beginDailyBriefFlight(key)
	if !leader {
		t.Fatal("first request must lead")
	}
	second, secondLeader := beginDailyBriefFlight(key)
	if secondLeader || second != first {
		t.Fatal("concurrent request must join the existing flight")
	}
	finishDailyBriefFlight(key, first)
	select {
	case <-second.done:
	default:
		t.Fatal("followers must be released when generation finishes")
	}
	third, thirdLeader := beginDailyBriefFlight(key)
	if !thirdLeader || third == first {
		t.Fatal("a later request must start a new flight")
	}
	finishDailyBriefFlight(key, third)
}
