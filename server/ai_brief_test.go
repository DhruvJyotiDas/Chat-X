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
