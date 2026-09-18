package main

import (
	"testing"
	"time"
)

func TestOpportunityFingerprintIsStableAndSensitive(t *testing.T) {
	one := opportunityFingerprint("create", "Planning review", "2026-09-18", "11:00")
	two := opportunityFingerprint("create", "Planning review", "2026-09-18", "11:00")
	changed := opportunityFingerprint("create", "Planning review", "2026-09-18", "11:30")
	if one != two {
		t.Fatal("the same opportunity must produce a stable fingerprint")
	}
	if one == changed {
		t.Fatal("a changed meeting time must reopen the opportunity")
	}
	if len(one) != 64 {
		t.Fatalf("expected a SHA-256 hex fingerprint, got %d characters", len(one))
	}
}

func TestDefaultProactivePreferencesKeepActionsReviewable(t *testing.T) {
	prefs := defaultProactivePreferences()
	if !prefs.Enabled || !prefs.MeetingSuggestions || !prefs.DailyPlanning || !prefs.TaskSignals ||
		!prefs.ReplySignals || !prefs.MeetingPrep || !prefs.PostMeeting || prefs.DailyLimit != 6 {
		t.Fatalf("unexpected proactive defaults: %+v", prefs)
	}
}

func TestQuietHoursAcrossMidnight(t *testing.T) {
	prefs := defaultProactivePreferences()
	prefs.TimeZone = "UTC"
	prefs.QuietStart = "21:00"
	prefs.QuietEnd = "08:00"
	for _, tc := range []struct {
		hour  int
		quiet bool
	}{{7, true}, {8, false}, {20, false}, {21, true}, {23, true}} {
		now := time.Date(2026, 9, 16, tc.hour, 0, 0, 0, time.UTC)
		if got := inQuietHours(prefs, now); got != tc.quiet {
			t.Fatalf("hour %d: expected quiet=%v, got %v", tc.hour, tc.quiet, got)
		}
	}
}

func TestEqualQuietHoursDisableQuietWindow(t *testing.T) {
	prefs := defaultProactivePreferences()
	prefs.TimeZone = "UTC"
	prefs.QuietStart = "09:00"
	prefs.QuietEnd = "09:00"
	if inQuietHours(prefs, time.Date(2026, 9, 16, 9, 0, 0, 0, time.UTC)) {
		t.Fatal("matching start and end should disable the quiet window")
	}
}
